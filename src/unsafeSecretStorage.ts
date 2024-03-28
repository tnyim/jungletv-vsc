import { Event, EventEmitter, SecretStorage, SecretStorageChangeEvent } from "vscode";

export class UnsafeSecretStorage implements SecretStorage {
    // this class exists because vscode on browser environments uses an in-memory secret storage, which is very useless

    private _loaded = false;
    private readonly _secrets = new Map<string, string>();

    constructor(
        private readonly blobLoader: () => Promise<string | undefined>,
        private readonly blobSaver: (blob: string) => Promise<void>,
        private readonly _encryptionSecret: string,
    ) { }

    async get(key: string): Promise<string | undefined> {
        if (!this._loaded) {
            await this.load();
        }
        return Promise.resolve(this._secrets.get(key));
    }
    async store(key: string, value: string): Promise<void> {
        if (!this._loaded) {
            await this.load();
        }
        this._secrets.set(key, value);
        await this.save();
        this.onDidChangeEmitter.fire({ key });
    }
    async delete(key: string): Promise<void> {
        if (!this._loaded) {
            await this.load();
        }
        this._secrets.delete(key);
        await this.save();
        this.onDidChangeEmitter.fire({ key });
    }

    private onDidChangeEmitter = new EventEmitter<SecretStorageChangeEvent>();
    onDidChange: Event<SecretStorageChangeEvent> = this.onDidChangeEmitter.event;

    private async load() {
        const _encryptionKey = await crypto.subtle.importKey(
            "raw",
            await this.base64ToBuffer(this._encryptionSecret),
            "AES-GCM",
            true,
            ["encrypt", "decrypt"]
        );

        this._secrets.clear();
        const blobJSON = await this.blobLoader();
        if (typeof blobJSON === "undefined") {
            this._loaded = true;
        }
        const blob = JSON.parse(blobJSON!) as { iv: string; ciphertext: string };

        const iv = await this.base64ToBuffer(blob.iv);
        const ciphertext = await this.base64ToBuffer(blob.ciphertext);
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            _encryptionKey,
            ciphertext
        );
        const decoded = new TextDecoder().decode(plaintext);
        const secrets = JSON.parse(decoded) as { [key: string]: string };
        for (const [key, value] of Object.entries(secrets)) {
            this._secrets.set(key, value);
        }
        this._loaded = true;
    }

    private async save() {
        const _encryptionKey = await crypto.subtle.importKey(
            "raw",
            await this.base64ToBuffer(this._encryptionSecret),
            "AES-GCM",
            true,
            ["encrypt", "decrypt"]
        );

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const encoded = enc.encode(JSON.stringify(Object.fromEntries(this._secrets)));
        const ciphertext = crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            _encryptionKey,
            encoded,
        );

        const blob = {
            iv: await this.bufferToBase64(iv),
            ciphertext: await this.bufferToBase64(await ciphertext),
        };

        await this.blobSaver(JSON.stringify(blob));
    }

    // via https://stackoverflow.com/a/66046176
    private async bufferToBase64(buffer: ArrayBuffer | Uint8Array) {
        // use a FileReader to generate a base64 data URI:
        const base64url = await new Promise<string>(r => {
            const reader = new FileReader();
            reader.onload = () => r(reader.result! as string);
            reader.readAsDataURL(new Blob([buffer]));
        });
        // remove the `data:...;base64,` part from the start
        return base64url.slice(base64url.indexOf(',') + 1);
    }

    private async base64ToBuffer(b64: string): Promise<Uint8Array> {
        const res = await fetch("data:application/octet-stream;base64," + b64);
        return new Uint8Array(await res.arrayBuffer());
    }
}