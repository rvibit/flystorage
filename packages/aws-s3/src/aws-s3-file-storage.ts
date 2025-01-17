import {
    _Object,
    CommonPrefix,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectAclCommand,
    GetObjectAclOutput,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListObjectsV2Output,
    ObjectCannedACL,
    PutObjectAclCommand,
    PutObjectCommandInput,
    S3Client,
    S3ServiceException,
} from '@aws-sdk/client-s3';
import {Configuration, Upload} from '@aws-sdk/lib-storage';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {
    ChecksumIsNotAvailable,
    ChecksumOptions,
    CreateDirectoryOptions,
    FileContents,
    normalizeExpiryToMilliseconds,
    PathPrefixer,
    PublicUrlOptions,
    StatEntry,
    StorageAdapter, TemporaryUrlOptions,
    Visibility,
    WriteOptions
} from '@flystorage/file-storage';
import {resolveMimeType} from '@flystorage/stream-mime-type';
import {Readable} from 'stream';
import {MimeTypeOptions, closeReadable} from "@flystorage/file-storage";
import {lookup} from "mime-types";

type PutObjectOptions = Omit<PutObjectCommandInput, 'Bucket' | 'Key'>;
const possibleChecksumAlgos = ['SHA1', 'SHA256', 'CRC32', 'CRC32C', 'ETAG'] as const;
type ChecksumAlgo = typeof possibleChecksumAlgos[number];

function isSupportedAlgo(algo: string): algo is ChecksumAlgo {
    return possibleChecksumAlgos.includes(algo as ChecksumAlgo);
}

export type AwsS3FileStorageOptions = Readonly<{
    bucket: string,
    prefix?: string,
    region?: string,
    publicUrlOptions?: PublicUrlOptions,
    putObjectOptions?: PutObjectOptions,
    uploadConfiguration?: Partial<Configuration>,
    defaultChecksumAlgo?: ChecksumAlgo,
}>;

export type AwsPublicUrlOptions = PublicUrlOptions & {
    bucket: string,
    region?: string,
    forcePathStyle?: boolean,
    baseUrl?: string,
}

export type AwsPublicUrlGenerator = {
    publicUrl(path: string, options: AwsPublicUrlOptions): Promise<string>;
};

export class DefaultAwsPublicUrlGenerator implements AwsPublicUrlGenerator {
    async publicUrl(path: string, options: AwsPublicUrlOptions): Promise<string> {
        const baseUrl = options.baseUrl ?? 'https://{subdomain}.amazonaws.com/{uri}';
        const subdomain = options.forcePathStyle !== true
            ? `${options.bucket}.s3`
            : options.region === undefined
                ? 's3'
                : `s3-${options.region}`;
        const uri = options.forcePathStyle !== true
            ? path
            : `${options.bucket}/${path}`;

        return baseUrl.replace('{subdomain}', subdomain).replace('{uri}', uri);
    }
}

/**
 * BC extension
 */
export class HostStyleAwsPublicUrlGenerator extends DefaultAwsPublicUrlGenerator {}

export type TimestampResolver = () => number;

export class AwsS3FileStorage implements StorageAdapter {
    private readonly prefixer: PathPrefixer;

    constructor(
        private readonly client: S3Client,
        private readonly options: AwsS3FileStorageOptions,
        private readonly publicUrlGenerator: AwsPublicUrlGenerator = new DefaultAwsPublicUrlGenerator(),
        private readonly timestampResolver: TimestampResolver = () => Date.now(),
    ) {
        this.prefixer = new PathPrefixer(options.prefix || '');
    }

    async temporaryUrl(path: string, options: TemporaryUrlOptions): Promise<string> {
        const expiry = normalizeExpiryToMilliseconds(options.expiresAt);
        const now = (this.timestampResolver)();

        return await getSignedUrl(this.client, new GetObjectCommand({
            Bucket: this.options.bucket,
            Key: this.prefixer.prefixFilePath(path),
        }), {
            expiresIn: Math.floor((expiry - now) / 1000),
        });
    }

    async mimeType(path: string, options: MimeTypeOptions): Promise<string> {
        const response = await this.stat(path);

        if (!response.isFile) {
            throw new Error(`Path "${path} is not a file.`);
        }

        if (response.mimeType) {
            return response.mimeType;
        }

        if (options.disallowFallback) {
            throw new Error('Mime-type not available via HeadObject');
        }

        const method = options.fallbackMethod ?? 'path';
        const mimeType = method === 'path'
            ? lookup(path)
            : await this.lookupMimeTypeFromStream(path, options);

        if (mimeType === undefined || mimeType === false) {
            throw new Error('Unable to resolve mime-type');
        }

        return mimeType;
    }

    async visibility(path: string): Promise<string> {
        const response: GetObjectAclOutput = await this.client.send(new GetObjectAclCommand({
            Bucket: this.options.bucket,
            Key: this.prefixer.prefixFilePath(path),
        }));

        const publicRead = response.Grants?.some(grant =>
            grant.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AllUsers'
            && grant.Permission === 'READ'
        ) ?? false;

        return publicRead ? Visibility.PUBLIC : Visibility.PRIVATE;
    }

    async* list(path: string, {deep}: {deep: boolean}): AsyncGenerator<StatEntry, any, unknown> {
        const listing = this.listObjects(path, {
            deep,
            includePrefixes: true,
            includeSelf: false,
        });

        for await (const {type, item} of listing) {
            if (type === 'prefix') {
                yield {
                    type: 'directory',
                    isFile: false,
                    isDirectory: true,
                    path: this.prefixer.stripDirectoryPath(item.Prefix!),
                };
            } else {
                const path = item.Key!;

                if (path.endsWith('/')) {
                    yield {
                        type: 'directory',
                        isFile: false,
                        isDirectory: true,
                        path: this.prefixer.stripDirectoryPath(path),
                    };
                } else {
                    yield {
                        type: 'file',
                        isFile: true,
                        isDirectory: false,
                        path: this.prefixer.stripFilePath(path),
                        size: item.Size ?? 0,
                        lastModifiedMs: item.LastModified?.getMilliseconds(),
                    };
                }
            }
        }
    }

    async* listObjects(
        path: string,
        options: {
            deep: boolean,
            includePrefixes: boolean,
            includeSelf: boolean,
            maxKeys?: number,
        },
    ): AsyncGenerator<{ type: 'prefix', item: CommonPrefix } | { type: 'object', item: _Object }, any, unknown> {
        const prefix = this.prefixer.prefixDirectoryPath(path);
        let collectedKeys = 0;
        let shouldContinue = true;
        let continuationToken: string | undefined = undefined;

        while (shouldContinue && (options.maxKeys === undefined || collectedKeys < options.maxKeys)) {
            const response: ListObjectsV2Output = await this.client.send(new ListObjectsV2Command({
                Bucket: this.options.bucket,
                Prefix: prefix,
                Delimiter: options.deep ? undefined : '/',
                ContinuationToken: continuationToken,
                MaxKeys: options.maxKeys,
            }));

            continuationToken = response.NextContinuationToken;
            shouldContinue = response.IsTruncated ?? false;
            const prefixes = options.includePrefixes ? response.CommonPrefixes ?? [] : [];

            for (const item of prefixes) {
                if ((!options.includeSelf && item.Prefix === prefix) || item.Prefix === undefined) {
                    continue;
                }

                collectedKeys++;
                yield {type: 'prefix', item};
            }

            for (const item of response.Contents ?? []) {
                if ((!options.includeSelf && item.Key === prefix) || item.Key === undefined) {
                    // not interested in itself
                    // not interested in empty prefixes
                    continue;
                }

                collectedKeys++;
                yield {type: 'object', item};
            }
        }
    }

    async read(path: string): Promise<FileContents> {
        const response = await this.client.send(new GetObjectCommand({
            Bucket: this.options.bucket,
            Key: this.prefixer.prefixFilePath(path),
        }));

        if (response.Body instanceof Readable) {
            return response.Body;
        }

        throw new Error('No response body was provided');
    }

    async stat(path: string): Promise<StatEntry> {
        const response = await this.client.send(new HeadObjectCommand({
            Bucket: this.options.bucket,
            Key: this.prefixer.prefixFilePath(path),
        }));

        return {
            path,
            type: 'file',
            isDirectory: false,
            isFile: true,
            size: response.ContentLength ?? 0,
            lastModifiedMs: response.LastModified?.getMilliseconds(),
            mimeType: response.ContentType,
        };
    }

    async createDirectory(path: string, options: CreateDirectoryOptions): Promise<void> {
        await this.upload(this.prefixer.prefixDirectoryPath(path), '', {
            ACL: options.directoryVisibility ? this.visibilityToAcl(options.directoryVisibility) : undefined,
        });
    }

    async deleteDirectory(path: string): Promise<void> {
        // @ts-ignore because we know it will only be objects
        let itemsToDelete: AsyncGenerator<{ item: _Object }> = this.listObjects(path, {
            deep: true,
            includeSelf: true,
            includePrefixes: false,
        });

        const flush = async (keys: { Key: string }[]) => this.client.send(new DeleteObjectsCommand({
            Bucket: this.options.bucket,
            Delete: {
                Objects: keys,
            },
        }));

        let bucket: { Key: string }[] = [];
        let promises: Promise<any>[] = [];

        for await (const {item} of itemsToDelete) {
            bucket.push({Key: item.Key!});

            if (bucket.length > 1000) {
                promises.push(flush(bucket));
                bucket = [];
            }
        }

        if (bucket.length > 0) {
            promises.push(flush(bucket));
        }

        await Promise.all(promises);
    }

    async write(path: string, contents: Readable, options: WriteOptions): Promise<void> {
        let mimeType = options.mimeType;

        if (mimeType === undefined) {
            [mimeType, contents] = await resolveMimeType(path, contents);
        }

        await this.upload(this.prefixer.prefixFilePath(path), contents, {
            ACL: options.visibility ? this.visibilityToAcl(options.visibility) : undefined,
            ContentType: mimeType,
            ContentLength: options.size,
        });
    }

    private async upload(key: string, contents: Readable | '', options: PutObjectOptions) {
        const params: PutObjectCommandInput = {
            Bucket: this.options.bucket,
            Key: key,
            Body: contents,
            ...Object.assign({}, this.options.putObjectOptions, options),
        };
        const upload = new Upload({
            client: this.client,
            params,
            ...this.options.uploadConfiguration,
        });

        await upload.done();
    }

    async deleteFile(path: string): Promise<void> {
        const key = this.prefixer.prefixFilePath(path);
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key: key,
        }));
    }

    private visibilityToAcl(visibility: string): ObjectCannedACL {
        if (visibility === Visibility.PUBLIC) {
            return 'public-read';
        } else if (visibility === Visibility.PRIVATE) {
            return 'private';
        }

        throw new Error(`Unrecognized visibility provided; ${visibility}`);
    }

    async changeVisibility(path: string, visibility: string): Promise<void> {
        await this.client.send(new PutObjectAclCommand({
            Bucket: this.options.bucket,
            Key: this.prefixer.prefixFilePath(path),
            ACL: this.visibilityToAcl(visibility),
        }));
    }

    async fileExists(path: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.options.bucket,
                Key: this.prefixer.prefixFilePath(path),
            }));

            return true;
        } catch (e) {
            if (e instanceof S3ServiceException && e.$metadata.httpStatusCode === 404) {
                return false;
            }

            throw e;
        }
    }

    async directoryExists(path: string): Promise<boolean> {
        const listing = this.listObjects(path, {
            deep: true,
            includePrefixes: true,
            includeSelf: true,
            maxKeys: 1,
        });

        for await (const _item of listing) {
            return true;
        }

        return false;
    }

    async publicUrl(path: string, options: PublicUrlOptions): Promise<string> {
        return this.publicUrlGenerator.publicUrl(this.prefixer.prefixFilePath(path), {
            bucket: this.options.bucket,
            ...options,
            ...this.options.publicUrlOptions,
        });
    }

    async checksum(path: string, options: ChecksumOptions): Promise<string> {
        const algo = (options.algo || this.options.defaultChecksumAlgo || 'SHA256').toUpperCase();

        if (!isSupportedAlgo(algo)) {
            throw ChecksumIsNotAvailable.checksumNotSupported(algo);
        }

        const responseKey = algo === 'ETAG' ? 'ETag' : `Checksum${algo}` as const;

        const response = await this.client.send(new HeadObjectCommand({
            Bucket: this.options.bucket,
            Key: this.prefixer.prefixFilePath(path),
            ...algo === 'ETAG' ? {} : {ChecksumMode: 'ENABLED'},
        }));

        const checksum = response[responseKey];

        if (checksum === undefined) {
            throw new Error(`Unable to retrieve checksum with algo ${algo}`);
        }

        return checksum.replace(/^"(.+)"$/, '$1');
    }

    private async lookupMimeTypeFromStream(path: string, options: MimeTypeOptions) {
        const [mimetype, stream] = await resolveMimeType(path, Readable.from(await this.read(path)));
        await closeReadable(stream);

        return mimetype;
    }
}