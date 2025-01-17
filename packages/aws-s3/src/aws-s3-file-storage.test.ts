import {S3Client} from '@aws-sdk/client-s3';
import {FileStorage, readableToString, Visibility, closeReadable} from '@flystorage/file-storage';
import {BinaryToTextEncoding, createHash, randomBytes} from 'crypto';
import * as https from 'https';
import {AwsS3FileStorage} from './aws-s3-file-storage.js';
import {createReadStream} from "node:fs";
import * as path from "node:path";

let client: S3Client;
let storage: FileStorage;
const testSegment = randomBytes(10).toString('hex');

describe('aws-s3 file storage', () => {
    const truncate = async () =>
        await new FileStorage(new AwsS3FileStorage(client, {
            bucket: 'flysystem-check',
            prefix: 'storage',
        })).deleteDirectory(testSegment);

    beforeAll(() => {
        client = new S3Client();
        storage = new FileStorage(new AwsS3FileStorage(client, {
            bucket: 'flysystem-check',
            prefix: `storage/${testSegment}`,
        }));
    })

    beforeEach(async () => {
        await truncate();
        storage = new FileStorage(new AwsS3FileStorage(client, {
            bucket: 'flysystem-check',
            prefix: 'storage/tests',
        }));
    });

    afterEach(async () => {
        await truncate();
    });

    afterAll(() => {
        client.destroy();
    })

    test('writing and reading a file', async () => {
        await storage.write('path.txt', 'this is the contents');

        expect(await storage.readToString('path.txt')).toEqual('this is the contents');
    });

    test('you can download public files using a public URL', async () => {
        await storage.write('public.txt', 'contents of the public file', {
            visibility: Visibility.PUBLIC,
        });

        const url = await storage.publicUrl('public.txt');
        const contents = await naivelyDownloadFile(url);

        expect(contents).toEqual('contents of the public file');
    });

    test('private files can only be downloaded using a temporary URL', async () => {
        await storage.write('private.txt', 'contents of the private file', {
            visibility: Visibility.PRIVATE,
        });

        await expect(naivelyDownloadFile(await storage.publicUrl('private.txt'))).rejects.toThrow();

        await expect(naivelyDownloadFile(
            await storage.temporaryUrl('private.txt', {expiresAt: Date.now() + 60 * 1000})
        )).resolves.toEqual('contents of the private file');
    });

    test('writing a png and fetching its mime-type', async () => {
        const handle = createReadStream(path.resolve(process.cwd(), 'fixtures/screenshot.png'));
        await storage.write('image.png', handle);
        closeReadable(handle);

        const mimeType = await storage.mimeType('image.png');

        expect(mimeType).toEqual('image/png');
    });

    test('it can request checksums', async () => {
        function hashString(input: string, algo: string, encoding: BinaryToTextEncoding = 'hex'): string {
            return createHash(algo).update(input).digest(encoding);
        }

        const contents = 'this is for the checksum';
        await storage.write('path.txt', contents);
        const expectedChecksum = hashString(contents, 'md5');

        const checksum = await storage.checksum('path.txt', {
            algo: 'etag',
        });

        expect(checksum).toEqual(expectedChecksum);
    });
});

function naivelyDownloadFile(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, async res => {
            if (res.statusCode !== 200) {
                reject(new Error(`Not able to download the file from ${url}, response status [${res.statusCode}]`));
            } else {
                resolve(await readableToString(res));
            }
        });
    });
}