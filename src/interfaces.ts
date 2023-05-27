'use strict';

import { ExtensionContext, WorkspaceFolder } from "vscode";
import { APIClient } from "./api_client";
import { JungleTVAFFS } from "./fileSystemProvider";

export interface JungleTVExtension {
    context(): ExtensionContext;
    getAPIClient(endpoint: string): Promise<APIClient | undefined>;
    fileSystemProvider(): JungleTVAFFS;
    currentlyOpenApplications(): Map<WorkspaceFolder, JungleTVApplication>;
    currentlyRunningApplications(): JungleTVApplication[];
}

export interface JungleTVApplication {
    endpoint: string;
    id: string;
}

export interface JungleTVFile {
	application: JungleTVApplication,
	fileName: string,
}