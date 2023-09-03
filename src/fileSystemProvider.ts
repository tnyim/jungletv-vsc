import { Mutex } from 'async-mutex';
import { Timestamp } from 'google-protobuf/google/protobuf/timestamp_pb';
import * as path from 'path';
import * as vscode from 'vscode';
import { APIClient } from './api_client';
import { JungleTVApplication, JungleTVExtension } from './interfaces';
import { ApplicationFile, ApplicationFilesRequest, CloneApplicationFileRequest, DeleteApplicationFileRequest, GetApplicationFileRequest, GetApplicationRequest, TypeScriptTypeDefinitionsRequest } from './proto/application_editor_pb';
import { JungleTV } from './proto/jungletv_pb_service';
import { applicationResource, authorityToEndpoint, fileResource } from './utils';

export type ParsedURI = {
	application: JungleTVApplication,
	fileName?: string,
}

export type JungleTVAFFileMetadata = {
	public: boolean,
	updatedAt: Date,
	fileType: string,
}

export type JungleTVAFApplicationMetadata = {
	allowLaunching: boolean,
	allowFileEditing: boolean,
	autorun: boolean,
	updatedAt: Date,
};

const tsTypesFilename = "*jungletv.d.ts";
export class JungleTVAFFS implements vscode.FileSystemProvider {
	static DefaultScheme = "jungletvaf" as const;
	private scheme: string;
	private extension: JungleTVExtension;

	// maps URIs to metadata
	private metadata = new Map<string, JungleTVAFFileMetadata>();
	private metadataUpdaterEmitter = new vscode.EventEmitter<Map<string, JungleTVAFFileMetadata>>();
	onMetadataUpdated: vscode.Event<Map<string, JungleTVAFFileMetadata>> = this.metadataUpdaterEmitter.event;

	private appMetadata = new Map<string, JungleTVAFApplicationMetadata>();
	private appMetadataUpdaterEmitter = new vscode.EventEmitter<Map<string, JungleTVAFApplicationMetadata>>();
	onApplicationMetadataUpdated: vscode.Event<Map<string, JungleTVAFApplicationMetadata>> = this.appMetadataUpdaterEmitter.event;

	// maps endpoints to TS type definitions
	private typeDefinitionsPerEndpoint = new Map<string, Uint8Array>();

	// contains application resource URIs for which we already did the typescript extension "priming" by briefly opening the types definition file
	private brieflyOpenedTypeDefinitionsForApplication = new Set<string>();

	constructor(extension: JungleTVExtension, scheme: string) {
		this.extension = extension;
		this.scheme = scheme;
	}

	public fileMetadata(): Map<string, JungleTVAFFileMetadata> {
		return new Map(this.metadata);
	}

	public applicationMetadata(): Map<string, JungleTVAFApplicationMetadata> {
		return new Map(this.appMetadata);
	}

	public parseURI(uri: vscode.Uri): ParsedURI {
		if (uri.scheme != this.scheme) {
			throw new Error("Unsupported scheme for JungleTVAFFS file system provider");
		}
		const parts = uri.path.split("/");
		let applicationID = "";
		let fileName: string | undefined;
		for (const part of parts) {
			if (!part) {
				continue;
			}
			if (!applicationID) {
				applicationID = part;
				continue;
			}
			if (!fileName) {
				fileName = part;
				continue;
			}
			fileName += "/" + part;
		}
		return {
			application: {
				endpoint: authorityToEndpoint(uri.authority),
				id: applicationID,
			},
			fileName
		};
	}

	private typeDefinitionsFetchMutex = new Mutex();
	private async getClient(endpoint: string): Promise<APIClient> {
		const apiClient = await this.extension.getAPIClient(endpoint);
		if (typeof apiClient === "undefined") {
			throw vscode.FileSystemError.Unavailable(`JungleTV environment at ${endpoint} is not configured`);
		}
		await this.typeDefinitionsFetchMutex.runExclusive(async () => {
			if (!this.typeDefinitionsPerEndpoint.has(endpoint)) {
				const files = vscode.workspace.getConfiguration('files');
				const exclude = files.get<{ [key: string]: boolean }>('exclude') ?? {};
				exclude["**/[*]jungletv.d.ts"] = true;
				await files.update('exclude', exclude, vscode.ConfigurationTarget.Workspace);

				try {
					const response = await apiClient.unaryRPC(JungleTV.TypeScriptTypeDefinitions, new TypeScriptTypeDefinitionsRequest());
					this.typeDefinitionsPerEndpoint.set(endpoint, response.getTypeDefinitionsFile_asU8());
				} catch (e) {
					console.log(`Failed to fetch TypeScript type definitions for endpoint ${endpoint}`, e);
				}
			}
		});
		return apiClient;
	}

	public prepareForOpeningApplication(application: JungleTVApplication) {
		const appResourceString = applicationResource(application).toString();
		if (!this.brieflyOpenedTypeDefinitionsForApplication.has(appResourceString)) {
			this.brieflyOpenedTypeDefinitionsForApplication.add(appResourceString);

			// run this asynchronously
			this.brieflyOpenTypesFile(application);
		}
	}

	private async brieflyOpenTypesFile(application: JungleTVApplication) {
		try {
			await this.getClient(application.endpoint); // ensure we actually attempted to load the types
			const uri = fileResource(application, tsTypesFilename);
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.Active,
				preserveFocus: true,
				preview: false,
			});
			for (const tab of vscode.window.tabGroups.all.map(tg => tg.tabs).flat()) {
				try {
					if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
						await vscode.window.tabGroups.close(tab);
					}
				} catch {
					// try on the next tab
				}
			}
		} catch {
			// everything about this is very "best effort"
		}
	}

	private catchError(e: unknown): never {
		if (typeof e === "string" && e.includes("file not found")) {
			throw vscode.FileSystemError.FileNotFound("File not found");
		}
		if (typeof e === "string" && e.includes("application not found")) {
			throw vscode.FileSystemError.Unavailable("Application not found");
		}
		if (typeof e === "string" && e.includes("application is currently read-only")) {
			throw vscode.FileSystemError.NoPermissions("Application currently read-only");
		}
		throw e;
	}

	private guessFileTypeFromName(fileName: string): string {
		// TODO expand this further
		let fileType: string;
		if (fileName.endsWith(".js")) {
			fileType = "text/javascript";
		} else if (fileName.endsWith(".ts")) {
			fileType = "text/typescript";
		} else if (fileName.endsWith(".json")) {
			fileType = "application/json";
		} else if (fileName.endsWith(".png")) {
			fileType = "image/png";
		} else if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
			fileType = "image/jpg";
		} else if (fileName.endsWith(".gif")) {
			fileType = "image/gif";
		} else if (fileName.endsWith(".webp")) {
			fileType = "image/webp";
		} else if (fileName.endsWith(".html") || fileName.endsWith(".htm")) {
			fileType = "text/html";
		} else if (fileName.endsWith(".md")) {
			fileType = "text/markdown";
		} else if (fileName.endsWith(".css")) {
			fileType = "text/css";
		} else {
			fileType = "text/plain";
		}
		return fileType;
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const parsedUri = this.parseURI(uri);
		const apiClient = await this.getClient(parsedUri.application.endpoint);

		if (parsedUri.fileName === tsTypesFilename) {
			return {
				type: vscode.FileType.File,
				size: this.typeDefinitionsPerEndpoint.get(parsedUri.application.endpoint)?.length ?? 0,
				ctime: 0,
				mtime: 0,
				permissions: vscode.FilePermission.Readonly,
			};
		}

		try {
			if (typeof parsedUri.fileName == "undefined") {
				// root directory
				const request = new GetApplicationRequest();
				request.setId(parsedUri.application.id);
				const response = await apiClient.unaryRPC(JungleTV.GetApplication, request);


				this.appMetadata.set(uri.toString(), {
					allowLaunching: response.getAllowLaunching(),
					allowFileEditing: response.getAllowFileEditing(),
					autorun: response.getAutorun(),
					updatedAt: new Date(timestampPbToMillis(response.getUpdatedAt())),
				});
				this.appMetadataUpdaterEmitter.fire(this.applicationMetadata());
				return {
					type: vscode.FileType.Directory,
					size: 0,
					ctime: timestampPbToMillis(response.getUpdatedAt()),
					mtime: timestampPbToMillis(response.getUpdatedAt()),
					permissions: vscode.FilePermission.Readonly,
				};
			}

			const request = new GetApplicationFileRequest();
			request.setApplicationId(parsedUri.application.id);
			request.setName(parsedUri.fileName ?? "");
			const response = await apiClient.unaryRPC(JungleTV.GetApplicationFile, request);

			this.metadata.set(uri.toString(), {
				public: response.getPublic(),
				updatedAt: new Date(timestampPbToMillis(response.getUpdatedAt())),
				fileType: response.getType(),
			});
			this.metadataUpdaterEmitter.fire(this.fileMetadata());

			const readWrite = this.appMetadata.get(applicationResource(parsedUri.application).toString())?.allowFileEditing ?? true;

			return {
				type: vscode.FileType.File,
				size: response.getContent_asU8().byteLength,
				ctime: timestampPbToMillis(response.getUpdatedAt()),
				mtime: timestampPbToMillis(response.getUpdatedAt()),
				permissions: readWrite ? undefined : vscode.FilePermission.Readonly,
			};
		} catch (e) {
			this.catchError(e);
		}
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const parsedUri = this.parseURI(uri);
		const apiClient = await this.getClient(parsedUri.application.endpoint);

		const request = new ApplicationFilesRequest();
		request.setApplicationId(parsedUri.application.id);
		const response = await apiClient.unaryRPC(JungleTV.ApplicationFiles, request);

		const result: [string, vscode.FileType][] = [];

		// delete all entries that belong to this application
		const metadata = new Map(
			[...this.metadata].filter(
				([key, value]) => this.parseURI(vscode.Uri.parse(key)).application != parsedUri.application));
		for (const applicationFile of response.getFilesList()) {
			result.push([applicationFile.getName() ?? "", vscode.FileType.File]);

			metadata.set(fileResource(parsedUri.application, applicationFile.getName()).toString(), {
				public: applicationFile.getPublic(),
				updatedAt: new Date(timestampPbToMillis(applicationFile.getUpdatedAt())),
				fileType: applicationFile.getType(),
			});
		}

		result.push([tsTypesFilename, vscode.FileType.File]);
		this.metadata = metadata;
		this.metadataUpdaterEmitter.fire(this.fileMetadata());
		return result;
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const parsedUri = this.parseURI(uri);
		const apiClient = await this.getClient(parsedUri.application.endpoint);

		this.prepareForOpeningApplication(parsedUri.application);

		if (parsedUri.fileName === tsTypesFilename) {
			return this.typeDefinitionsPerEndpoint.get(parsedUri.application.endpoint) ?? new Uint8Array();
		}

		try {
			const request = new GetApplicationFileRequest();
			request.setApplicationId(parsedUri.application.id);
			request.setName(parsedUri.fileName ?? "");
			const response = await apiClient.unaryRPC(JungleTV.GetApplicationFile, request);

			return response.getContent_asU8();
		} catch (e) {
			this.catchError(e);
		}
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		const parsedUri = this.parseURI(uri);

		if (parsedUri.fileName === tsTypesFilename) {
			throw vscode.FileSystemError.NoPermissions("The type definitions file is special and cannot be edited");
		}

		const apiClient = await this.getClient(parsedUri.application.endpoint);

		if (typeof parsedUri.fileName === "undefined") {
			throw new Error("A filename could not be identified from the supplied URI");
		}

		if (parsedUri.fileName?.startsWith("*")) {
			throw new Error("Invalid filename");
		}

		let existingFile: ApplicationFile | undefined;
		let isCreating: boolean;
		try {
			const request = new GetApplicationFileRequest();
			request.setApplicationId(parsedUri.application.id);
			request.setName(parsedUri.fileName ?? "");
			existingFile = await apiClient.unaryRPC(JungleTV.GetApplicationFile, request);
			isCreating = false;
		} catch (e) {
			if (typeof e === "string" && e.includes("file not found")) {
				isCreating = true;
			} else {
				throw e;
			}
		}

		if (isCreating && !options.create) {
			throw vscode.FileSystemError.FileNotFound("File does not exist and create is not set");
		}
		if (!isCreating && options.create && !options.overwrite) {
			throw vscode.FileSystemError.FileExists("File already exists, create is set but overwrite is not set");
		}

		try {
			let request: ApplicationFile;
			if (isCreating || typeof existingFile === "undefined") {
				request = new ApplicationFile();
				request.setApplicationId(parsedUri.application.id);
				request.setName(parsedUri.fileName);

				const fileType = await vscode.window.showInputBox({
					title: "File type",
					prompt: "Enter the MIME type for the file being created",
					placeHolder: this.guessFileTypeFromName(parsedUri.fileName),
					value: this.guessFileTypeFromName(parsedUri.fileName),
					ignoreFocusOut: true,
				});
				if (typeof fileType === "undefined") {
					vscode.window.showInformationMessage(`File creation aborted`);
					return;
				}
				request.setType(fileType);

				const publicPickOption = await vscode.window.showQuickPick([
					"Public",
					"Internal"
				], {
					title: `Should ${parsedUri.fileName} be public (served over HTTP) or internal?`,
					canPickMany: false,
					ignoreFocusOut: true,
				});
				if (typeof publicPickOption === "undefined") {
					vscode.window.showInformationMessage(`File creation aborted`);
					return;
				}
				request.setPublic(publicPickOption == "Public");
			} else {
				request = existingFile;
			}
			request.setContent(content);

			const editMessage = await vscode.window.showInputBox({
				title: `${isCreating ? "Creating" : "Updating"} ${parsedUri.fileName}`,
				prompt: "Enter an edit message",
				ignoreFocusOut: true,
				placeHolder: `${isCreating ? "Create" : "Update"} ${parsedUri.fileName}`,
				value: `${isCreating ? "Create" : "Update"} ${parsedUri.fileName}`,
			});
			if (typeof editMessage === "undefined") {
				vscode.window.showInformationMessage(`File ${isCreating ? "creation" : "update"} aborted`);
				return;
			}
			request.setEditMessage(editMessage);

			await apiClient.unaryRPC(JungleTV.UpdateApplicationFile, request);
			if (isCreating) {
				this._fireSoon({ type: vscode.FileChangeType.Created, uri });
			} else {
				this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
			}
		} catch (e) {
			this.catchError(e);
		}

	}

	async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		const parsedSourceUri = this.parseURI(source);
		const parsedDestinationUri = this.parseURI(destination);

		const readWrite = this.appMetadata.get(applicationResource(parsedDestinationUri.application).toString())?.allowFileEditing ?? true;
		if (!readWrite) {
			throw vscode.FileSystemError.NoPermissions("Application currently read-only");
		}

		if (typeof parsedSourceUri.fileName === "undefined" || typeof parsedDestinationUri.fileName === "undefined") {
			throw vscode.FileSystemError.Unavailable("Copying directories is unsupported");
		}

		if (parsedDestinationUri.fileName?.startsWith("*")) {
			throw new Error("Invalid filename");
		}

		if (parsedSourceUri.application.endpoint !== parsedDestinationUri.application.endpoint) {
			await this.copyBetweenEnvironments(source, destination, options);
			return;
		}


		const apiClient = await this.getClient(parsedSourceUri.application.endpoint);

		const request = new CloneApplicationFileRequest();
		request.setApplicationId(parsedSourceUri.application.id);
		request.setName(parsedSourceUri.fileName);
		request.setDestinationApplicationId(parsedDestinationUri.application.id);
		request.setDestinationName(parsedDestinationUri.fileName);

		try {
			await apiClient.unaryRPC(JungleTV.CloneApplicationFile, request);
			this._fireSoon({ type: vscode.FileChangeType.Created, uri: destination });
		} catch (e) {
			this.catchError(e);
		}
	}

	private async copyBetweenEnvironments(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		const parsedSourceUri = this.parseURI(source);
		const parsedDestinationUri = this.parseURI(destination);

		const readWrite = this.appMetadata.get(applicationResource(parsedDestinationUri.application).toString())?.allowFileEditing ?? true;
		if (!readWrite) {
			throw vscode.FileSystemError.NoPermissions("Application currently read-only");
		}

		const sourceApiClient = await this.getClient(parsedSourceUri.application.endpoint);
		const destinationApiClient = await this.getClient(parsedDestinationUri.application.endpoint);
		try {
			const request = new GetApplicationFileRequest();
			request.setApplicationId(parsedSourceUri.application.id);
			request.setName(parsedSourceUri.fileName ?? "");
			const response = await sourceApiClient.unaryRPC(JungleTV.GetApplicationFile, request);

			let destinationFileExists = false;
			try {
				const request = new GetApplicationFileRequest();
				request.setApplicationId(parsedDestinationUri.application.id);
				request.setName(parsedDestinationUri.fileName ?? "");
				await destinationApiClient.unaryRPC(JungleTV.GetApplicationFile, request);
				destinationFileExists = true;
			} catch (e) {
				if (typeof e !== "string" || !e.includes("file not found")) {
					throw e;
				}
			}

			if (destinationFileExists && !options.overwrite) {
				throw vscode.FileSystemError.FileExists("Destination file already exists, but overwrite is not set");
			}

			const destWriteRequest = response.clone();
			destWriteRequest.setApplicationId(parsedDestinationUri.application.id);
			destWriteRequest.setName(parsedDestinationUri.fileName ?? "");

			await destinationApiClient.unaryRPC(JungleTV.UpdateApplicationFile, destWriteRequest);
			this._fireSoon({ type: vscode.FileChangeType.Created, uri: destination });
		} catch (e) {
			this.catchError(e);
		}
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		const parsedOldUri = this.parseURI(oldUri);
		if (parsedOldUri.fileName === tsTypesFilename) {
			throw vscode.FileSystemError.NoPermissions("The type definitions file is special and cannot be renamed");
		}

		const readWriteOld = this.appMetadata.get(
			applicationResource(parsedOldUri.application).toString())?.allowFileEditing ?? true;
		if (!readWriteOld) {
			throw vscode.FileSystemError.NoPermissions("Application currently read-only");
		}

		const readWriteNew = this.appMetadata.get(
			applicationResource(this.parseURI(newUri).application).toString())?.allowFileEditing ?? true;
		if (!readWriteNew) {
			throw vscode.FileSystemError.NoPermissions("Application currently read-only");
		}

		if (this.parseURI(newUri).fileName?.startsWith("*")) {
			throw new Error("Invalid filename");
		}

		await this.copy(oldUri, newUri, options);
		await this.delete(oldUri);
	}

	async delete(uri: vscode.Uri): Promise<void> {
		const parsedUri = this.parseURI(uri);
		const apiClient = await this.getClient(parsedUri.application.endpoint);
		const dirname = uri.with({ path: path.posix.dirname(uri.path) });

		if (parsedUri.fileName?.startsWith("*")) {
			throw new Error("Invalid filename");
		}

		try {
			const request = new DeleteApplicationFileRequest();
			request.setApplicationId(parsedUri.application.id);
			request.setName(parsedUri.fileName ?? "");
			await apiClient.unaryRPC(JungleTV.DeleteApplicationFile, request);
			this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted });
		} catch (e) {
			this.catchError(e);
		}
	}

	createDirectory(uri: vscode.Uri): void {
		throw vscode.FileSystemError.Unavailable("The JungleTV Application Framework does not support directories");
		//this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { type: vscode.FileChangeType.Created, uri });
	}

	async updateFileMetadata(uri: vscode.Uri, makePublic?: boolean, mimeType?: string): Promise<void> {
		const parsedUri = this.parseURI(uri);
		const apiClient = await this.getClient(parsedUri.application.endpoint);

		try {
			const request = new GetApplicationFileRequest();
			request.setApplicationId(parsedUri.application.id);
			request.setName(parsedUri.fileName ?? "");

			const file = await apiClient.unaryRPC(JungleTV.GetApplicationFile, request);

			if (typeof makePublic !== "undefined") {
				file.setPublic(makePublic);
			}
			if (typeof mimeType !== "undefined") {
				file.setType(mimeType);
			}

			await apiClient.unaryRPC(JungleTV.UpdateApplicationFile, file);

			this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
		} catch (e) {
			this.catchError(e);
		}
	}

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private _bufferedEvents: vscode.FileChangeEvent[] = [];
	private _fireSoonHandle?: NodeJS.Timer;

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => { });
	}

	private _fireSoon(...events: vscode.FileChangeEvent[]): void {
		this._bufferedEvents.push(...events);

		if (this._fireSoonHandle) {
			clearTimeout(this._fireSoonHandle);
		}

		this._fireSoonHandle = setTimeout(() => {
			this._emitter.fire(this._bufferedEvents);
			this._bufferedEvents.length = 0;
		}, 5);
	}
}


function timestampPbToMillis(t: Timestamp | undefined): number {
	if (typeof t === "undefined") {
		return 0;
	}
	return t.getSeconds() * 1000 + t.getNanos() / 1000000;
}