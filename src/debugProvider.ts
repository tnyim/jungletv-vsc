'use strict';

import { grpc } from '@improbable-eng/grpc-web';
import { Request } from '@improbable-eng/grpc-web/dist/typings/invoke';
import { DebugSession, ErrorDestination, Event, ExitedEvent, InitializedEvent, OutputEvent, TerminatedEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as vscode from 'vscode';
import { DebugAdapter } from 'vscode';
import { APIClient, StreamRequestController } from './api_client';
import { JungleTVApplication, JungleTVExtension } from './interfaces';
import { ApplicationLogEntry, ApplicationLogEntryContainer, ApplicationLogLevel, ConsumeApplicationLogRequest, EvaluateExpressionOnApplicationRequest, LaunchApplicationRequest, StopApplicationRequest } from './proto/application_editor_pb';
import { JungleTV } from './proto/jungletv_pb_service';
import { beautifyEndpoint, fileResource, resourceToApplication } from './utils';

interface JungleTVDebugConfiguration extends vscode.DebugConfiguration {
    request: typeof RequestTypes.AttachToApplication | typeof RequestTypes.LaunchApplication;
    workspaceFolder: vscode.WorkspaceFolder | undefined;
    application: JungleTVApplication;
}

interface AttachToApplicationDebugConfiguration extends JungleTVDebugConfiguration {
    request: typeof RequestTypes.AttachToApplication;
    showOlderLogs: boolean;
}

interface LaunchApplicationDebugConfiguration extends JungleTVDebugConfiguration {
    request: typeof RequestTypes.LaunchApplication;
    restart: boolean;
    showOlderLogs: boolean;
}

abstract class RequestTypes {
    static readonly AttachToApplication = "attach" as const;
    static readonly LaunchApplication = "launch" as const;
}

export class JungleTVAFDebugProvider implements vscode.DebugConfigurationProvider {
    static JungleTVDebugConfigurationType = "jungletvaf" as const;

    private extension: JungleTVExtension;

    constructor(extension: JungleTVExtension) {
        this.extension = extension;

        extension.context().subscriptions.push(vscode.commands.registerCommand("jungletvaf.debug.openConsoleInBrowser", () => {
            if (vscode.debug.activeDebugSession?.type === "jungletvaf") {
                const configuration = <JungleTVDebugConfiguration>vscode.debug.activeDebugSession.configuration;
                const url = new URL(configuration.application.endpoint);
                url.pathname += `${url.pathname.endsWith("/") ? '' : '/'}moderate/applications/${configuration.application.id}/console`;
                vscode.env.openExternal(vscode.Uri.parse(url.toString()));
            }
        }));
    }

    provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken | undefined): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        const applications = this.extension.currentlyOpenApplications();
        const runningApplicationIDs = this.extension.currentlyRunningApplications().map(a => a.id);

        const configs: vscode.DebugConfiguration[] = [];

        for (const [workspaceFolder, application] of applications) {
            if (!folder || folder.uri.toString() === workspaceFolder.uri.toString()) {
                if (runningApplicationIDs.includes(application.id)) {
                    configs.push(this.getAttachToApplicationConfiguration(application, false, undefined, workspaceFolder));
                } else {
                    configs.push(this.getLaunchApplicationConfiguration(application, false, true, undefined, workspaceFolder));
                }
            }
        }

        return configs;
    }

    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, debugConfiguration: vscode.DebugConfiguration, token?: vscode.CancellationToken | undefined): vscode.ProviderResult<vscode.DebugConfiguration> {
        switch (debugConfiguration.request) {
            case RequestTypes.AttachToApplication:
                {
                    const config: AttachToApplicationDebugConfiguration = <any>debugConfiguration;
                    return this.getAttachToApplicationConfiguration(
                        config.application, config.showOlderLogs, config, folder);
                }
            case RequestTypes.LaunchApplication:
                {
                    const config: LaunchApplicationDebugConfiguration = <any>debugConfiguration;
                    return this.getLaunchApplicationConfiguration(
                        config.application, config.restart, config.showOlderLogs, config, folder);
                }
            default:
                {
                    if (typeof folder !== "undefined") {
                        try {
                            const application = resourceToApplication(folder.uri);
                            const runningApplicationIDs = this.extension.currentlyRunningApplications().map(a => a.id);
                            if (runningApplicationIDs.includes(application.id)) {
                                return this.getAttachToApplicationConfiguration(application, false, debugConfiguration, folder);
                            }
                            return this.getLaunchApplicationConfiguration(application, false, false, debugConfiguration, folder);
                        } catch {
                            return null;
                        }
                    }
                }

        }
        return null;
    }

    public getAttachToApplicationConfiguration(application: JungleTVApplication, showOlderLogs: boolean, configuration?: vscode.DebugConfiguration, workspaceFolder?: vscode.WorkspaceFolder): AttachToApplicationDebugConfiguration {
        const base: AttachToApplicationDebugConfiguration = {
            name: `Attach to Running Application ${application.id} on ${beautifyEndpoint(application.endpoint)}`,
            request: "attach",
            type: JungleTVAFDebugProvider.JungleTVDebugConfigurationType,
            application: application,
            showOlderLogs,
            workspaceFolder
        };
        if (typeof configuration === "undefined") {
            configuration = base;
        }
        return Object.assign(configuration, base);
    }

    public getLaunchApplicationConfiguration(application: JungleTVApplication, restart: boolean, showOlderLogs: boolean, configuration?: vscode.DebugConfiguration, workspaceFolder?: vscode.WorkspaceFolder): LaunchApplicationDebugConfiguration {
        const base: LaunchApplicationDebugConfiguration = {
            name: `Launch and Attach to Application ${application.id} on ${beautifyEndpoint(application.endpoint)}`,
            request: "launch",
            type: JungleTVAFDebugProvider.JungleTVDebugConfigurationType,
            application: application,
            restart,
            showOlderLogs,
            workspaceFolder
        };
        if (typeof configuration === "undefined") {
            configuration = base;
        }
        return Object.assign(configuration, base);
    }
}

export class JungleTVAFDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    private extension: JungleTVExtension;

    constructor(extension: JungleTVExtension) {
        this.extension = extension;
    }

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const config: JungleTVDebugConfiguration = <any>session.configuration;
        if (!config) {
            return undefined;
        }
        return new vscode.DebugAdapterInlineImplementation(new JungleTVDebugSession(this.extension, config));
    }
}

export class JungleTVDebugSession extends DebugSession implements DebugAdapter {
    private configuration: JungleTVDebugConfiguration;
    private extension: JungleTVExtension;
    private application: JungleTVApplication;
    private restartApplicationIfRunning = false;
    private showOlderLogs = false;

    private hadBeenConnected = false;
    private _apiClient: APIClient | undefined;
    private streamController: StreamRequestController | undefined;
    private resolveDisconnect: (() => void) | undefined = undefined;

    private isRestartingApplication = false;

    constructor(extension: JungleTVExtension, configuration: JungleTVDebugConfiguration) {
        super();
        this.configuration = configuration;
        this.extension = extension;
        this.application = configuration.application;

        switch (configuration.request) {
            case RequestTypes.AttachToApplication:
                {
                    const config: AttachToApplicationDebugConfiguration = <any>configuration;
                    this.showOlderLogs = config.showOlderLogs;
                }
                break;
            case RequestTypes.LaunchApplication:
                {
                    const config: LaunchApplicationDebugConfiguration = <any>configuration;
                    this.restartApplicationIfRunning = config.restart;
                    this.showOlderLogs = config.showOlderLogs;
                }
                break;
        }
    }

    getApplication(): JungleTVApplication {
        return this.application;
    }

    private async apiClient(): Promise<APIClient> {
        if (typeof this._apiClient !== "undefined") {
            return this._apiClient;
        }
        const apiClient = await this.extension.getAPIClient(this.application.endpoint);
        if (typeof apiClient === "undefined") {
            throw new Error(`JungleTV environment ${beautifyEndpoint(this.application.endpoint)} not configured`);
        }
        this._apiClient = apiClient;
        return apiClient;
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportTerminateDebuggee = true;
        response.body.supportsTerminateRequest = true;
        response.body.supportsRestartRequest = true;
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    handleMessage(msg: DebugProtocol.ProtocolMessage): void {
        console.log("handleMessage", msg);
        super.handleMessage(msg);
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request | undefined): void {
        //console.log("configurationDoneRequest done");
        this.sendResponse(response);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        this.sendEvent(new OutputEvent(
            `Launching and connecting to application ${this.application.id} on ${beautifyEndpoint(this.application.endpoint)}...\n`,
            "console"));

        const apiRequest = new LaunchApplicationRequest();
        apiRequest.setId(this.application.id);
        try {
            await (await this.apiClient()).unaryRPC(JungleTV.LaunchApplication, apiRequest);

            await this.connectToApplication();
        } catch (e) {
            this.sendEvent(new OutputEvent(`Failed to launch application: ${e}\n`, "console"));
            this.sendEvent(new TerminatedEvent());
        }
        this.sendResponse(response);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        this.sendEvent(new OutputEvent(
            `Connecting to running application ${this.application.id} on ${beautifyEndpoint(this.application.endpoint)}...\n`,
            "console"));
        await this.connectToApplication();
        this.sendResponse(response);
    }

    private async connectToApplication() {
        const apiClient = await this.apiClient();

        const request = new ConsumeApplicationLogRequest();
        request.setApplicationId(this.application.id);

        const consumeApplicationLog = function (
            onUpdate: (update: ApplicationLogEntryContainer) => void,
            onEnd: (code: grpc.Code, msg: string) => void): Request {
            return apiClient.serverStreamingRPC(
                JungleTV.ConsumeApplicationLog,
                request,
                onUpdate,
                onEnd);
        };

        this.streamController = apiClient.consumeStreamRPC(
            20000,
            5000,
            consumeApplicationLog,
            this.onApplicationLogMessage.bind(this),
            this.onApplicationLogConnectionStatusChanged.bind(this));
    }

    private onApplicationLogMessage(entryContainer: ApplicationLogEntryContainer) {
        if (entryContainer.getIsHeartbeat()) {
            return;
        }
        const entry = entryContainer.getEntry();
        if (!entry) {
            return;
        }
        this.emitApplicationLogEntry(entry);
    }

    private emitApplicationLogEntry(entry: ApplicationLogEntry) {
        let category = "stdout";
        let prefix = "";
        let exitCode: number | undefined;
        if (entry.getLevel() == ApplicationLogLevel.APPLICATION_LOG_LEVEL_JS_ERROR ||
            entry.getLevel() == ApplicationLogLevel.APPLICATION_LOG_LEVEL_RUNTIME_ERROR) {
            category = "stderr";
        } else if (entry.getLevel() == ApplicationLogLevel.APPLICATION_LOG_LEVEL_JS_WARN) {
            category = "console";
        }
        if (entry.getLevel() == ApplicationLogLevel.APPLICATION_LOG_LEVEL_RUNTIME_ERROR ||
            entry.getLevel() == ApplicationLogLevel.APPLICATION_LOG_LEVEL_RUNTIME_LOG) {
            prefix = "[RUNTIME] ";
            const matches = /^application instance terminated with [0-9]+ job[s]{0,1} remaining and exit code ([0-9]+)$/.exec(entry.getMessage());
            if (matches) {
                exitCode = +matches[1];
            }
        }
        this.sendEvent(new OutputEvent(prefix + entry.getMessage() + "\n", category));
        if (typeof exitCode !== "undefined") {
            this.sendEvent(new ExitedEvent(exitCode));
        }
    }

    private onApplicationLogConnectionStatusChanged(connected: boolean) {
        if (connected) {
            this.sendEvent(new OutputEvent("Connected to application\n", "console"));
            if (!this.hadBeenConnected) {
                this.hadBeenConnected = true;
                const event = new Event("process", {
                    name: fileResource(this.application, "main.js").toString(),
                    isLocalProcess: false,
                    startMethod: this.configuration.request,
                });
                this.sendEvent(event);
            }
        } else if (this.hadBeenConnected) {
            this.sendEvent(new OutputEvent("Disconnected from application\n", "console"));
            if (typeof this.resolveDisconnect !== "undefined") {
                this.resolveDisconnect();
            } else if (!this.isRestartingApplication) {
                this.sendEvent(new TerminatedEvent());
            }
        }
    }

    protected async restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        const disconnectPromise = new Promise<void>((resolve) => {
            this.resolveDisconnect = resolve;
        });

        this.isRestartingApplication = true;

        try {
            const apiClient = await this.apiClient();

            const stopRequest = new StopApplicationRequest();
            stopRequest.setId(this.application.id);

            this.sendEvent(new OutputEvent(`Stopping application...\n`, "console"));

            await apiClient.unaryRPC(JungleTV.StopApplication, stopRequest);
            await disconnectPromise;

            this.isRestartingApplication = false;
            this.resolveDisconnect = undefined;

            this.sendEvent(new OutputEvent(`Relaunching application...\n`, "console"));

            const launchRequest = new LaunchApplicationRequest();
            launchRequest.setId(this.application.id);

            await apiClient.unaryRPC(JungleTV.LaunchApplication, launchRequest);
            this.streamController?.rebuildAndReconnect();
        } catch (e) {
            this.sendEvent(new OutputEvent(`Failed to restart application: ${e}\n`, "console"));
        }

        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request | undefined): void {
        response.body = {
            threads: [{
                id: 0,
                name: "Event loop",
            }]
        };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request | undefined): void {
        this.sendEvent(new OutputEvent("JungleTV AF applications cannot be paused\n", "important"));
        this.sendResponse(response);
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        if (args.terminateDebuggee) {
            const apiRequest = new StopApplicationRequest();
            apiRequest.setId(this.application.id);

            this.sendEvent(new OutputEvent(`Stopping application...\n`, "console"));

            try {
                await (await this.apiClient()).unaryRPC(JungleTV.StopApplication, apiRequest);
            } catch (e) {
                this.sendEvent(new OutputEvent(`Failed to stop application: ${e}...\n`, "console"));
                this.sendEvent(new TerminatedEvent());
            }
        }
        this.sendResponse(response);
    }

    protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        const apiRequest = new StopApplicationRequest();
        apiRequest.setId(this.application.id);

        this.sendEvent(new OutputEvent(`Stopping application...\n`, "console"));

        try {
            await (await this.apiClient()).unaryRPC(JungleTV.StopApplication, apiRequest);
            if (args.restart) {
                // TODO actually wait for the application to stop, since the request to stop is asynchronous

                // TODO restart application
            }
        } catch (e) {
            this.sendEvent(new OutputEvent(`Failed to stop application: ${e}...\n`, "console"));
            this.sendEvent(new TerminatedEvent());
        }
        // this.sendEvent(new TerminatedEvent()); // no need to send because the disconnection takes care of this
        this.sendResponse(response);
    }

    private sendUserVisibleErrorResponse(response: DebugProtocol.Response, msg: string) {
        this.sendErrorResponse(response, {
            id: 0,
            format: msg,
            showUser: false, // this controls whether a notification appears
        }, msg, undefined, ErrorDestination.User);
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        if (args.context != "repl") {
            this.sendResponse(response);
            return;
        }

        response.command = request?.command ?? "";

        const respondWithError = (msg: string) => {
            response.body = {
                result: msg,
                variablesReference: 0,
            };
            this.sendUserVisibleErrorResponse(response, msg);
        };

        if (!this.hadBeenConnected) {
            respondWithError("Please wait, not connected to application yet!");
            return;
        }

        if (typeof args.frameId !== "undefined") {
            respondWithError("Evaluating on stack frames is not supported by the JungleTV Application Framework");
            return;
        }

        try {
            const apiRequest = new EvaluateExpressionOnApplicationRequest();
            apiRequest.setApplicationId(this.application.id);
            apiRequest.setExpression(args.expression);

            const apiResponse = await (await this.apiClient()).unaryRPC(JungleTV.EvaluateExpressionOnApplication, apiRequest);

            if (apiResponse.getSuccessful()) {
                response.body = {
                    result: apiResponse.getResult(),
                    variablesReference: 0,
                };
                this.sendResponse(response);
            } else {
                const r = apiResponse.getResult();
                response.body = {
                    result: r,
                    variablesReference: 0,
                };
                this.sendErrorResponse(response, {
                    id: 0,
                    format: r,
                    showUser: false, // this controls whether a notification appears
                }, r, undefined, ErrorDestination.User);
            }
        } catch (e) {
            respondWithError("Failed to evaluate: " + e);
        }
    }

    dispose() {
        this.streamController?.dispose();
    }
}