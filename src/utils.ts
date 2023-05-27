'use strict';

import * as vscode from 'vscode';
import { JungleTVAFFS } from "./fileSystemProvider";
import { JungleTVApplication, JungleTVFile } from "./interfaces";

export function beautifyEndpoint(endpoint: string): string {
    const u = new URL(endpoint);
    return u.host;
}

export function endpointToAuthority(endpoint: string): string {
    const url = new URL(endpoint);
    let authority = url.host;
    if (url.pathname != "" && url.pathname != "/") {
        authority = encodeURIComponent(url.host + url.pathname);
    }
    return authority;
}

export function authorityToEndpoint(authority: string): string {
    return "https://" + decodeURIComponent(authority);
}

export function applicationResource(application: JungleTVApplication): vscode.Uri {
    return vscode.Uri.from({
        scheme: JungleTVAFFS.DefaultScheme,
        authority: endpointToAuthority(application.endpoint),
        path: `/${application.id}`,
    });
}

export function fileResource(application: JungleTVApplication, fileName: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: JungleTVAFFS.DefaultScheme,
        authority: endpointToAuthority(application.endpoint),
        path: `/${application.id}/${fileName}`,
    });
}

export function resourceToApplication(uri: vscode.Uri): JungleTVApplication {
    if (uri.scheme != JungleTVAFFS.DefaultScheme) {
        throw new Error("Invalid scheme for JungleTV Application");
    }
    const parts = uri.path.split("/");
    let applicationID = "";
    for (const part of parts) {
        if (!part) {
            continue;
        }
        if (!applicationID) {
            applicationID = part;
            break;
        }
    }
    return {
        endpoint: authorityToEndpoint(uri.authority),
        id: applicationID,
    };
}

export function resourceToFile(uri: vscode.Uri): JungleTVFile {
    if (uri.scheme != JungleTVAFFS.DefaultScheme) {
        throw new Error("Invalid scheme for JungleTV Application File");
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
    if (!fileName) {
        throw new Error("could not parse filename from resource URI");
    }
    return {
        application: {
            endpoint: authorityToEndpoint(uri.authority),
            id: applicationID,
        },
        fileName
    };
}
