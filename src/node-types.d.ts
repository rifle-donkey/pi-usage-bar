// Narrow declarations for the Node APIs used by src/. Not packaged.
declare module "node:fs" {
	export const constants: {
		O_RDONLY: number;
		O_WRONLY: number;
		O_CREAT: number;
		O_EXCL: number;
		O_NONBLOCK: number;
		O_NOFOLLOW?: number;
	};
}

declare module "node:fs/promises" {
	interface FileHandle {
		stat(): Promise<{ isFile(): boolean; size: number }>;
		read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
		writeFile(data: string): Promise<void>;
		chmod(mode: number): Promise<void>;
		sync(): Promise<void>;
		close(): Promise<void>;
	}
	export function open(path: string, flags: number, mode?: number): Promise<FileHandle>;
	export function lstat(path: string): Promise<{ isFile(): boolean }>;
	export function mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
	export function link(existingPath: string, newPath: string): Promise<void>;
	export function rename(oldPath: string, newPath: string): Promise<void>;
	export function unlink(path: string): Promise<void>;
}

declare module "node:os" {
	export function homedir(): string;
}

declare module "node:path" {
	export function dirname(path: string): string;
	export function join(...parts: string[]): string;
}

declare const process: { env: Record<string, string | undefined> };
declare const Buffer: { from(value: string, encoding: "base64url"): { toString(encoding: "utf8"): string } };
