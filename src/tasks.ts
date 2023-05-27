'use strict';
import * as vscode from 'vscode';
import { JungleTVApplication, JungleTVExtension } from './interfaces';
import { LaunchApplicationRequest, StopApplicationRequest } from './proto/application_editor_pb';
import { JungleTV } from './proto/jungletv_pb_service';
import { beautifyEndpoint } from './utils';

interface JungleTVTaskDefinition extends vscode.TaskDefinition {
    type: typeof JungleTVTaskProvider.JungleTVTaskType;
    subtype: string;
    workspaceFolder: vscode.WorkspaceFolder | undefined;
}

interface LaunchApplicationTaskDefinition extends JungleTVTaskDefinition {
    application: JungleTVApplication,
    restart: boolean;
}

interface StopApplicationTaskDefinition extends JungleTVTaskDefinition {
    application: JungleTVApplication
}

abstract class SubtaskTypes {
    static readonly LaunchApplication = "launchApplication" as const;
    static readonly StopApplication = "stopApplication" as const;
}

export class JungleTVTaskProvider implements vscode.TaskProvider {
    static JungleTVTaskType = "JungleTV" as const;

    private extension: JungleTVExtension;

    constructor(extension: JungleTVExtension) {
        this.extension = extension;
    }

    public provideTasks(token: vscode.CancellationToken): vscode.Task[] {
        const applications = this.extension.currentlyOpenApplications();
        const runningApplicationIDs = this.extension.currentlyRunningApplications().map(a => a.id);

        const tasks: vscode.Task[] = [];
        for (const [workspaceFolder, application] of applications) {
            if (runningApplicationIDs.includes(application.id)) {
                tasks.push(this.getLaunchApplicationTask(application, true, undefined, workspaceFolder));
                tasks.push(this.getStopApplicationTask(application, undefined, workspaceFolder));
            } else {
                tasks.push(this.getLaunchApplicationTask(application, false, undefined, workspaceFolder));
            }
        }
        return tasks;
    }
    public resolveTask(task: vscode.Task, token: vscode.CancellationToken): vscode.Task | undefined {
        const subtype: string = task.definition.subtype;
        if (!subtype) {
            return undefined;
        }
        switch (subtype) {
            case SubtaskTypes.LaunchApplication:
                {
                    const definition: LaunchApplicationTaskDefinition = <any>task.definition;
                    return this.getLaunchApplicationTask(
                        definition.application, definition.restart, definition, definition.workspaceFolder);
                }
        }
        return undefined;
    }

    public getLaunchApplicationTask(application: JungleTVApplication, restart: boolean, mustUseDefinition?: LaunchApplicationTaskDefinition, workspaceFolder?: vscode.WorkspaceFolder): vscode.Task {
        if (typeof mustUseDefinition === "undefined") {
            mustUseDefinition = {
                type: JungleTVTaskProvider.JungleTVTaskType,
                subtype: SubtaskTypes.LaunchApplication,
                application: application,
                restart,
                workspaceFolder
            };
        }
        return new vscode.Task(mustUseDefinition,
            workspaceFolder ?? vscode.TaskScope.Workspace,
            `${restart ? "Restart" : "Launch"} application ${application.id} on ${beautifyEndpoint(application.endpoint)}`,
            "JungleTV AF",
            new vscode.CustomExecution(this.executeLaunchApplicationTask.bind(this)));
    }

    private async executeLaunchApplicationTask(resolvedDefinition: vscode.TaskDefinition): Promise<vscode.Pseudoterminal> {
        const definition = <LaunchApplicationTaskDefinition>resolvedDefinition;
        return new TaskTerminal(async (writeFn: (str: string) => void, cancellationToken: vscode.CancellationToken): Promise<number> => {
            writeFn(`${definition.restart ? "Restarting" : "Launching"} application ${definition.application.id} on environment ${beautifyEndpoint(definition.application.endpoint)}\r\n`);
            const apiClient = await this.extension.getAPIClient(definition.application.endpoint);
            if (typeof apiClient === "undefined") {
                writeFn(`Failed: environment ${beautifyEndpoint(definition.application.endpoint)} is not configured.\r\n`);
                return -1;
            }
            if (definition.restart) {
                writeFn(`Stopping application...\r\n`);
                const request = new StopApplicationRequest();
                request.setId(definition.application.id);
                await apiClient.unaryRPC(JungleTV.StopApplication, request);
            }
            writeFn(`Launching application...\r\n`);
            const request = new LaunchApplicationRequest();
            request.setId(definition.application.id);
            await apiClient.unaryRPC(JungleTV.LaunchApplication, request);

            writeFn("Application launched\r\n");
            return 0;
        });
    }

    public getStopApplicationTask(application: JungleTVApplication, mustUseDefinition?: StopApplicationTaskDefinition, workspaceFolder?: vscode.WorkspaceFolder): vscode.Task {
        if (typeof mustUseDefinition === "undefined") {
            mustUseDefinition = {
                type: JungleTVTaskProvider.JungleTVTaskType,
                subtype: SubtaskTypes.StopApplication,
                application: application,
                workspaceFolder
            };
        }
        return new vscode.Task(mustUseDefinition,
            workspaceFolder ?? vscode.TaskScope.Workspace,
            `Stop application ${application.id} on ${beautifyEndpoint(application.endpoint)}`,
            "JungleTV AF",
            new vscode.CustomExecution(this.executeStopApplicationTask.bind(this)));
    }

    private async executeStopApplicationTask(resolvedDefinition: vscode.TaskDefinition): Promise<vscode.Pseudoterminal> {
        const definition = <StopApplicationTaskDefinition>resolvedDefinition;
        return new TaskTerminal(async (writeFn: (str: string) => void, cancellationToken: vscode.CancellationToken): Promise<number> => {
            writeFn(`Stopping application ${definition.application.id} on environment ${beautifyEndpoint(definition.application.endpoint)}\r\n`);
            const apiClient = await this.extension.getAPIClient(definition.application.endpoint);
            if (typeof apiClient === "undefined") {
                writeFn(`Failed: environment ${beautifyEndpoint(definition.application.endpoint)} is not configured.\r\n`);
                return -1;
            }

            const request = new StopApplicationRequest();
            request.setId(definition.application.id);
            await apiClient.unaryRPC(JungleTV.StopApplication, request);

            writeFn("Application stopped\r\n");
            return 0;
        });
    }
}

type TerminalPromiseConstructor = (writeFn: (arg0: string) => void, cancellationToken: vscode.CancellationToken) => Promise<number>
class TaskTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private closeEmitter = new vscode.EventEmitter<number>();
    onDidClose?: vscode.Event<number> = this.closeEmitter.event;

    private promiseConstructor: TerminalPromiseConstructor;
    private cancellationTokenSource: vscode.CancellationTokenSource;
    private done = false;

    constructor(promiseConstructor: TerminalPromiseConstructor) {
        this.promiseConstructor = promiseConstructor;
        this.cancellationTokenSource = new vscode.CancellationTokenSource();
    }

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        this.promiseConstructor(this.writeEmitter.fire.bind(this.writeEmitter), this.cancellationTokenSource.token).
            then((exitCode) => {
                this.done = true;
                this.closeEmitter.fire(exitCode);
            }, (reason) => {
                this.done = true;
                this.writeEmitter.fire("\n" + reason + "\n");
                this.closeEmitter.fire(-1);
            });
    }

    close(): void {
        if (!this.done) {
            this.cancellationTokenSource.cancel();
        }
    }
}