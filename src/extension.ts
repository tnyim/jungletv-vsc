'use strict';

import { grpc } from '@improbable-eng/grpc-web';
import { Request } from '@improbable-eng/grpc-web/dist/typings/invoke';
import { Mutex } from 'async-mutex';
import * as vscode from 'vscode';
import { QuickPickItem } from 'vscode';
import { APIClient, StreamRequestController } from './api_client';
import { JungleTVAFDebugAdapterDescriptorFactory, JungleTVAFDebugProvider } from './debugProvider';
import { JungleTVAFFS } from './fileSystemProvider';
import { JungleTVApplication, JungleTVExtension } from './interfaces';
import { Application, ApplicationsRequest, GetApplicationRequest, MonitorRunningApplicationsRequest, RunningApplications } from './proto/application_editor_pb';
import { AuthorizeApplicationEvent, AuthorizeApplicationRequest, PermissionLevel, UserPermissionLevelRequest } from './proto/jungletv_pb';
import { JungleTV } from './proto/jungletv_pb_service';
import { JungleTVTaskProvider } from './tasks';
import { applicationResource, beautifyEndpoint, resourceToApplication, resourceToFile } from './utils';

export async function activate(context: vscode.ExtensionContext) {
	const ext = new JungleTVExtensionImpl(context);
	await ext.activate();
}

abstract class GlobalStateKeys {
	static readonly Environments = "environments" as const;
}

class JungleTVExtensionImpl implements JungleTVExtension {
	private ctx: vscode.ExtensionContext;
	private fs: JungleTVAFFS;
	private taskProvider: JungleTVTaskProvider;
	private debugProvider: JungleTVAFDebugProvider;
	private apiClients = new Map<string, APIClient>();
	private runningApplicationsPerEndpoint = new Map<string, JungleTVApplication[]>();
	private longLivedConnectionsPerEndpoint = new Map<string, StreamRequestController>();

	constructor(context: vscode.ExtensionContext) {
		this.ctx = context;
		this.fs = new JungleTVAFFS(this, JungleTVAFFS.DefaultScheme);
		this.taskProvider = new JungleTVTaskProvider(this);
		this.debugProvider = new JungleTVAFDebugProvider(this);
	}

	public async activate() {
		const context = this.ctx;
		context.subscriptions.push(vscode.workspace.registerFileSystemProvider(JungleTVAFFS.DefaultScheme, this.fs, { isCaseSensitive: true }));
		context.subscriptions.push(vscode.tasks.registerTaskProvider(JungleTVTaskProvider.JungleTVTaskType, this.taskProvider));
		context.subscriptions.push(
			vscode.debug.registerDebugConfigurationProvider(
				JungleTVAFDebugProvider.JungleTVDebugConfigurationType, this.debugProvider, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

		context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(JungleTVAFDebugProvider.JungleTVDebugConfigurationType, new JungleTVAFDebugAdapterDescriptorFactory(this)));

		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.testCommand', async _ => {
			console.log("Hello!");
		}));

		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.launchApplication', async (uri: vscode.Uri) => {
			vscode.tasks.executeTask(this.taskProvider.getLaunchApplicationTask(resourceToApplication(uri), false, undefined, this.findWorkspaceFolderOfApplicationUri(uri)));
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.launchAndAttachToApplication', async (uri: vscode.Uri) => {
			const folder = this.findWorkspaceFolderOfApplicationUri(uri);
			const config = await this.debugProvider.getLaunchApplicationConfiguration(resourceToApplication(uri), false, false, undefined, folder);
			vscode.debug.startDebugging(folder, config);
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.attachToApplication', async (uri: vscode.Uri) => {
			const folder = this.findWorkspaceFolderOfApplicationUri(uri);
			const config = await this.debugProvider.getAttachToApplicationConfiguration(resourceToApplication(uri), false, undefined, folder);
			vscode.debug.startDebugging(folder, config);
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.restartApplication', async (uri: vscode.Uri) => {
			vscode.tasks.executeTask(this.taskProvider.getLaunchApplicationTask(resourceToApplication(uri), true, undefined, this.findWorkspaceFolderOfApplicationUri(uri)));
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.stopApplication', async (uri: vscode.Uri) => {
			vscode.tasks.executeTask(this.taskProvider.getStopApplicationTask(resourceToApplication(uri), undefined, this.findWorkspaceFolderOfApplicationUri(uri)));
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.openApplicationEditorInBrowser', async (uri: vscode.Uri) => {
			const application = resourceToApplication(uri);
			const url = new URL(application.endpoint);
			url.pathname += `${url.pathname.endsWith("/") ? '' : '/'}moderate/applications/${application.id}`;
			vscode.env.openExternal(vscode.Uri.parse(url.toString()));
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.configureNewEnvironment', this.configureNewEnvironment, this));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.forgetEnvironment', this.forgetEnvironment, this));

		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.editApplication', this.editApplication, this));

		context.subscriptions.push(this.fs.onMetadataUpdated((metadata => {
			const publicFiles: vscode.Uri[] = [];
			for (const [uri, m] of metadata) {
				if (m.public) {
					publicFiles.push(vscode.Uri.parse(uri));
				}
			}
			vscode.commands.executeCommand('setContext', 'jungletvaf.publicFiles', publicFiles);
		})));

		context.subscriptions.push(this.fs.onApplicationMetadataUpdated((metadata => {
			const launchableApplications: vscode.Uri[] = [];
			const editableApplications: vscode.Uri[] = [];
			for (const [uri, m] of metadata) {
				if (m.allowLaunching) {
					launchableApplications.push(vscode.Uri.parse(uri));
				}
				if (m.allowFileEditing) {
					editableApplications.push(vscode.Uri.parse(uri));
				}
			}
			vscode.commands.executeCommand('setContext', 'jungletvaf.launchableApplications', launchableApplications);
			vscode.commands.executeCommand('setContext', 'jungletvaf.editableApplications', editableApplications);
		})));

		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.makeFilePublic', async (uri: vscode.Uri) => {
			try {
				await this.fs.updateFileMetadata(uri, true);
				vscode.window.setStatusBarMessage(`${resourceToFile(uri).fileName} made public`, 5000);
			} catch (e) {
				vscode.window.showErrorMessage(`Failed to make ${resourceToFile(uri).fileName} public: ${e}`);
			}
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.makeFileInternal', async (uri: vscode.Uri) => {
			try {
				await this.fs.updateFileMetadata(uri, false);
				vscode.window.setStatusBarMessage(`${resourceToFile(uri).fileName} made internal`, 5000);
			} catch (e) {
				vscode.window.showErrorMessage(`Failed to make ${resourceToFile(uri).fileName} internal: ${e}`);
			}
		}));
		context.subscriptions.push(vscode.commands.registerCommand('jungletvaf.setFileMimeType', async (uri: vscode.Uri) => {
			const fileName = resourceToFile(uri).fileName;
			try {
				const metadata = this.fs.fileMetadata().get(uri.toString());
				if (typeof metadata === "undefined") {
					throw new Error("Metadata not available");
				}

				const fileType = await vscode.window.showInputBox({
					title: "File type",
					prompt: `Enter the MIME type for ${fileName}`,
					placeHolder: metadata.fileType,
					value: metadata.fileType,
					ignoreFocusOut: true,
				});
				if (typeof fileType === "undefined") {
					vscode.window.setStatusBarMessage(`MIME type change aborted`, 5000);
					return;
				}
				await this.fs.updateFileMetadata(uri, undefined, fileType);
				vscode.window.setStatusBarMessage(`${fileName} MIME type updated`, 5000);
			} catch (e) {
				vscode.window.showErrorMessage(`Failed to update ${fileName} MIME type: ${e}`);
			}
		}));

		await this.getConfiguredEnvironments();
	}

	public context() {
		return this.ctx;
	}

	public fileSystemProvider(): JungleTVAFFS {
		return this.fs;
	}

	public currentlyOpenApplications(): Map<vscode.WorkspaceFolder, JungleTVApplication> {
		return new Map(vscode.workspace.workspaceFolders?.
			filter(folder => folder.uri.scheme == JungleTVAFFS.DefaultScheme).
			map(folder => [folder, this.fs.parseURI(folder.uri).application]) ?? []);
	}

	private findWorkspaceFolderOfApplicationUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.
			find(folder => folder.uri.toString() == uri.toString());
	}

	public currentlyRunningApplications(): JungleTVApplication[] {
		return Array.from(this.runningApplicationsPerEndpoint.values()).flat();
	}

	private async hashEndpoint(endpoint: string): Promise<string> {
		const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
		return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join("");
	}

	private async getAuthSecretForEndpoint(endpoint: string): Promise<string | undefined> {
		const h = await this.hashEndpoint(endpoint);
		const expiryString = await this.ctx.secrets.get(`jungletvaf.endpointsecretexpiry.${h}`);
		if (new Date(Number(expiryString)).getTime() < Date.now()) {
			return undefined;
		}
		return await this.ctx.secrets.get(`jungletvaf.endpointsecret.${await this.hashEndpoint(endpoint)}`);
	}

	private async setAuthSecretForEndpoint(endpoint: string, secret: string, expiry: Date): Promise<void> {
		const h = await this.hashEndpoint(endpoint);
		await this.ctx.secrets.store(`jungletvaf.endpointsecretexpiry.${h}`, expiry.getTime().toString());
		await this.ctx.secrets.store(`jungletvaf.endpointsecret.${h}`, secret);
	}

	private async forgetAuthSecretForEndpoint(endpoint: string) {
		const h = await this.hashEndpoint(endpoint);
		await this.ctx.secrets.delete(`jungletvaf.endpointsecretexpiry.${h}`);
		await this.ctx.secrets.delete(`jungletvaf.endpointsecret.${h}`);
	}

	async getConfiguredEnvironments(): Promise<string[]> {
		const environments = this.ctx.globalState.get<string[]>(GlobalStateKeys.Environments) ?? [];
		if (environments.length) {
			vscode.commands.executeCommand('setContext', 'jungletvaf.hasConfiguredEnvironments', true);
		} else {
			vscode.commands.executeCommand('setContext', 'jungletvaf.hasConfiguredEnvironments', false);
		}
		vscode.commands.executeCommand('setContext', 'jungletvaf.configuredEnvironments', environments);
		return environments;
	}

	private apiClientCreationMutex = new Mutex();
	async getAPIClient(endpoint: string): Promise<APIClient | undefined> {
		return this.apiClientCreationMutex.runExclusive(async () => {
			if (this.apiClients.has(endpoint)) {
				return this.apiClients.get(endpoint)!;
			}

			const secret = await this.getAuthSecretForEndpoint(endpoint);
			if (typeof secret === "undefined") {
				const choice = await vscode.window.showInformationMessage(
					`Authentication token for JungleTV environment ${beautifyEndpoint(endpoint)} missing or expired. Reauthorize the JungleTV AF development helper on this environment, or remove it?`,
					{
						modal: true,
					},
					"Remove environment", "Reauthorize");
				if (choice == 'Reauthorize') {
					await this.configureNewEnvironment(endpoint);
					return this.getAPIClient(endpoint);
				}
				await this.forgetEnvironment(endpoint, false);
				return undefined;
			}

			const client = new APIClient(endpoint, secret, (token, expiry) => {
				this.setAuthSecretForEndpoint(endpoint, token, expiry);
			});
			this.apiClients.set(endpoint, client);
			this.startLongLivedConnectionsForEndpoint(endpoint, client);
			return client;
		});
	}

	private async startLongLivedConnectionsForEndpoint(endpoint: string, client: APIClient) {
		const monitorRunningApplications = function (onUpdate: (update: RunningApplications) => void, onEnd: (code: grpc.Code, msg: string) => void): Request {
			const request = new MonitorRunningApplicationsRequest();
			return client.serverStreamingRPC(
				JungleTV.MonitorRunningApplications,
				request,
				onUpdate,
				onEnd);
		};

		const controller = client.consumeStreamRPC(
			20000,
			5000,
			monitorRunningApplications,
			(runningApplications) => {
				if (runningApplications.getIsHeartbeat()) {
					return;
				}
				this.updateRunningApplicationsForEndpoint(
					endpoint, runningApplications.getRunningApplicationsList().map(a => a.getApplicationId()));
			});

		this.longLivedConnectionsPerEndpoint.set(endpoint, controller);

		this.ctx.subscriptions.push(controller);
	}

	private updateRunningApplicationsForEndpoint(endpoint: string, applicationIDs: string[]) {
		this.runningApplicationsPerEndpoint.set(endpoint, applicationIDs.map(id => {
			return {
				endpoint,
				id
			};
		}));
		const runningApplications = Array.from(this.runningApplicationsPerEndpoint.values()).flat().map(a => applicationResource(a));
		vscode.commands.executeCommand('setContext', 'jungletvaf.runningApplications', runningApplications);
	}

	private async configureNewEnvironment(url?: string): Promise<string | undefined> {
		while (typeof url === "undefined") {
			url = await vscode.window.showInputBox({
				title: "Configuring JungleTV environment",
				prompt: "Enter environment URL",
				ignoreFocusOut: true,
			});
			if (typeof url === "undefined") {
				return;
			}
			try {
				const environmentURL = new URL(url);
				if (environmentURL.protocol !== "https") {
					continue;
				}
			} catch {
				continue;
			}
		}

		while (url.endsWith("/")) {
			url = url.slice(0, url.length - 1);
		}

		const authResult = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Waiting for you to authorize the JungleTV environment connection in the browser...",
			cancellable: true
		}, async (progress, cancellationToken): Promise<{ token: string, expiry: Date } | undefined> => {
			try {
				return await this.authorizeOnEnvironment(url ?? "", cancellationToken);
			} catch (e) {
				vscode.window.showErrorMessage(`An error ocurred when connecting to the environment: ${e}`);
			}
		});
		if (typeof authResult == "undefined") {
			return;
		}

		// test endpoint connection with the obtained auth token
		const tentativeClient = new APIClient(url, authResult.token);
		try {
			const response = await tentativeClient.unaryRPC(JungleTV.UserPermissionLevel, new UserPermissionLevelRequest());
			if (response.getPermissionLevel() != PermissionLevel.APPEDITOR) {
				vscode.window.showErrorMessage("The provided authentication token does not have the required permissions for editing applications.");
				return;
			}
		} catch (e) {
			vscode.window.showErrorMessage(`An error ocurred when connecting to the environment: ${e}`);
			return;
		}

		let environments = this.ctx.globalState.get<string[]>(GlobalStateKeys.Environments) ?? [];
		environments.push(url);
		environments = environments.filter((value, index, array) => array.indexOf(value) === index);
		await this.ctx.globalState.update(GlobalStateKeys.Environments, environments);
		await this.setAuthSecretForEndpoint(url, authResult.token, authResult.expiry);
		await this.getConfiguredEnvironments();

		vscode.window.showInformationMessage(`Configured JungleTV environment at ${beautifyEndpoint(url)}`);
		return url;
	}

	private async forgetEnvironment(endpoint?: string, useMutex = true): Promise<void> {
		let environments = this.ctx.globalState.get<string[]>(GlobalStateKeys.Environments) ?? [];
		if (typeof endpoint === "undefined") {
			type itemType = QuickPickItem & { endpoint: string };
			const items = environments.map(e => {
				const item: itemType = {
					label: beautifyEndpoint(e),
					endpoint: e,
				};
				return item;
			});

			const selectedItem = await vscode.window.showQuickPick(items, {
				title: "Select the environment to forget",
				canPickMany: false,
			});
			if (!selectedItem) {
				return;
			}
			endpoint = selectedItem.endpoint!;
		}

		// close all open files for this environment
		for (const tab of vscode.window.tabGroups.all.map(tg => tg.tabs).flat()) {
			try {
				if (tab.input instanceof vscode.TabInputText && resourceToFile(tab.input.uri).application.endpoint == endpoint) {
					await vscode.window.tabGroups.close(tab);
				}
			} catch {
				// likely not a jungletvaf file
				continue;
			}
		}

		// close all workspace folders for this environment
		for (let i = 0; i < (vscode.workspace.workspaceFolders?.length ?? 0); i++) {
			const folder = vscode.workspace.workspaceFolders![i];
			try {
				const application = resourceToApplication(folder.uri);
				if (application.endpoint == endpoint) {
					vscode.workspace.updateWorkspaceFolders(i, 1);
				}
			} catch {
				// likely not a jungletvaf folder
				continue;
			}
		}

		const p = async () => {
			environments = this.ctx.globalState.get<string[]>(GlobalStateKeys.Environments) ?? [];
			environments = environments.filter(v => v != endpoint);
			await this.ctx.globalState.update(GlobalStateKeys.Environments, environments);
			this.longLivedConnectionsPerEndpoint.get(endpoint!)?.dispose();
			this.apiClients.delete(endpoint!);
			await this.forgetAuthSecretForEndpoint(endpoint!);
			await this.getConfiguredEnvironments();
		};
		if (useMutex) {
			await this.apiClientCreationMutex.runExclusive(p);
		} else {
			await p();
		}

		vscode.window.showInformationMessage(`Forgot JungleTV environment at ${beautifyEndpoint(endpoint)}`);
	}

	private async authorizeOnEnvironment(url: string, cancellationToken: vscode.CancellationToken): Promise<{ token: string, expiry: Date }> {
		let resolve: (value: { token: string, expiry: Date } | PromiseLike<{ token: string, expiry: Date }>) => void;
		let reject: (reason?: any) => void;
		const promise = new Promise<{ token: string, expiry: Date }>((r, rj) => { resolve = r; reject = rj; });
		const client = new APIClient(url); // unauthenticated client

		const request = new AuthorizeApplicationRequest();
		request.setApplicationName("JungleTV AF development helper for Visual Studio Code");
		request.setDesiredPermissionLevel(PermissionLevel.APPEDITOR);
		request.setReason("You are configuring a new environment in the JungleTV AF VSCode extension.\nThe extension needs to obtain an authentication token that grants sufficient privileges to edit application files and launch/stop applications in this environment.");
		const r = client.serverStreamingRPC(JungleTV.AuthorizeApplication, request, message => {
			switch (message.getEventCase()) {
				case AuthorizeApplicationEvent.EventCase.AUTHORIZATION_URL: {
					const authurl = message.getAuthorizationUrl()?.getAuthorizationUrl() ?? "";
					vscode.env.openExternal(vscode.Uri.parse(authurl));
					break;
				}
				case AuthorizeApplicationEvent.EventCase.APPROVED:
					r.close();
					if (!message.getApproved()) {
						return;
					}
					resolve({
						token: message.getApproved()!.getAuthToken(),
						expiry: message.getApproved()!.getTokenExpiration()!.toDate()
					});
					break;
			}
		}, (endCode, endMessage) => {
			reject("Connection closed before obtaining authentication token");
		});

		return await promise;
	}

	private async editApplication(endpoint?: string, applicationID?: string): Promise<void> {
		if (typeof endpoint === "undefined") {
			type itemType = QuickPickItem & { isAddOption: boolean, endpoint?: string };
			const environments = this.ctx.globalState.get<string[]>(GlobalStateKeys.Environments) ?? [];
			const items = environments.map(e => {
				const item: itemType = {
					label: beautifyEndpoint(e),
					isAddOption: false,
					endpoint: e,
				};
				return item;
			});
			items.push({
				isAddOption: true,
				label: "Configure New Environment",
			});

			const selectedItem = await vscode.window.showQuickPick(items, {
				title: "Select the environment where the application is located",
				canPickMany: false,
			});
			if (!selectedItem) {
				return;
			}
			if (selectedItem?.isAddOption) {
				const maybeEnv = await this.configureNewEnvironment();
				if (!maybeEnv) {
					return;
				}
				endpoint = maybeEnv;
			}
			endpoint = selectedItem.endpoint!;
		}
		const apiClient = await this.getAPIClient(endpoint); // this might take a while as it might prompt for reauth
		if (typeof apiClient === "undefined") {
			vscode.window.showErrorMessage(`Can't add application as the environment at ${beautifyEndpoint(endpoint)} is not configured.`);
			return;
		}

		if (typeof applicationID === "undefined") {
			const response = await apiClient.unaryRPC(JungleTV.Applications, new ApplicationsRequest());
			const options: (QuickPickItem & { applicationID?: string, isCreateAppOption: boolean })[] = response.getApplicationsList().map(a => ({
				isCreateAppOption: false,
				applicationID: a.getId(),
				label: a.getId(),
			}));
			options.push({
				isCreateAppOption: true,
				label: "Create New Application",
			});
			const picked = await vscode.window.showQuickPick(options, {
				title: "Select the application to add to the workspace",
				ignoreFocusOut: true,
				canPickMany: false,
			});
			if (typeof picked === "undefined") {
				return;
			}
			if (picked.isCreateAppOption) {
				for (; ;) {
					const id = await vscode.window.showInputBox({
						title: "Create New Application",
						prompt: "Enter the ID for the new application",
						ignoreFocusOut: true,
					});
					if (typeof id === "undefined") {
						return;
					}

					try {
						const request = new GetApplicationRequest();
						request.setId(id);
						await apiClient.unaryRPC(JungleTV.GetApplication, request);
						vscode.window.showInformationMessage(`Application ${id} already exists`);
						continue;
					} catch {
						const request = new Application();
						request.setId(id);
						request.setAllowFileEditing(true);
						try {
							await apiClient.unaryRPC(JungleTV.UpdateApplication, request);
							applicationID = id;
							break;
						} catch (e) {
							vscode.window.showErrorMessage(`Failed to create the application: ${e}`);
						}
					}
				}
			} else {
				applicationID = picked.applicationID!;
			}
		}

		try {
			const r = new GetApplicationRequest();
			r.setId(applicationID);
			const response = await apiClient.unaryRPC(JungleTV.GetApplication, r);

			const uri = applicationResource({
				endpoint,
				id: response.getId(),
			});

			vscode.workspace.updateWorkspaceFolders(0, 0, { uri: uri, name: `Application ${applicationID} on ${beautifyEndpoint(endpoint)}` });
		} catch (e) {
			vscode.window.showErrorMessage(`An error ocurred when loading the application: ${e}`);
		}
	}
}

