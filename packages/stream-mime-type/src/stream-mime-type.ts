import {Readable} from 'node:stream';
import {parse} from 'node:path';
import {lookup as mimeTimeForExt} from 'mime-types';
import {PassThrough} from 'node:stream';

function concatUint8Arrays(input: Uint8Array[]): Uint8Array {
    const length = input.reduce((l, a) => l + a.byteLength, 0);
    const output = new Uint8Array(length);
    let position = 0;
    input.forEach(i => {
        output.set(i, position);
        position += i.byteLength;
    });

    return output;
}

async function streamHead(stream: Readable, size: number): Promise<[Uint8Array, Readable]> {
    return new Promise((resolve, reject) => {
        const tunnel = new PassThrough();
        const outputStream = new PassThrough();
        let readBytes = 0;
        let buffers: Uint8Array[] = [];
        let resolved = false;

        tunnel.once('error', reject);
        tunnel.on('data', (chunk: Uint8Array) => {
            if (!resolved) {
                readBytes += chunk.byteLength;
                buffers.push(chunk);

                if (readBytes >= size) {
                    resolved = true;
                    const head = concatUint8Arrays(buffers);
                    buffers = [];
                    resolve([head, outputStream]);
                }
            }
        });
        tunnel.once('end', () => {
            if (!resolved) {
                resolve([concatUint8Arrays(buffers), outputStream]);
            }
        });
        stream.pipe(tunnel).pipe(outputStream);
    });
}

export async function resolveMimeType(
    filename: string,
    stream: Readable,
    fallback: string | undefined = undefined
): Promise<[string|undefined, Readable]> {
    const [head, readable] = await streamHead(stream, 4100);
    const {fileTypeFromBuffer} = await import('file-type');
    const lookup = await fileTypeFromBuffer(head);

    if (lookup) {
        return [lookup.mime, readable];
    }

    const {ext} = parse(filename);

    return [mimeTimeForExt(ext) || fallback, readable];
}