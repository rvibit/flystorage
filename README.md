# Flystorage
Flystorage is a file storage abstraction for NodeJS and TypeScript. It is an 80/20 solution
that is built around a set of goals:

- Application code should not be aware WHERE files are stored.
- Pragmatically smooth over underlying storage differences.
- Provide an async/await based API, promises all the way.
- Maximise cross-implementation portability.
- Abstract over file permissions using "visibility".

### What is Flystorage NOT:
Flystorage is meant to be used in cases for generic file storage use-cases. It's not an API for
any  specific filesystem. It's a generalised solution and will not implement feature only
specific to one particular storage implementation. There will be use-cases that are not catered
to, simply because they cannot be abstracted over in a reasonable manner.

## Capabilities

### Implemented
- [x] Write files using string | buffer | readable/stream
- [x] Read files as stream, string, or Uint8Array
- [x] Set permissions using abstracted visibility
- [x] List the contents of a directory/prefix, (shallow and deep).
- [x] Delete files without failing when they don't exist.
- [x] Delete directories (and any files it contains)
- [x] Generate public URLs.
- [x] Generate temporary (signed) URLs.
- [x] Expose or calculate checksums for files.
- [x] Mime-type resolving

### Planned
- [ ] Last modified fetching
- [ ] File size

## Implementations / Adapters

### Implemented
- [x] Local Filesystem
- [x] AWS S3 (using the V3 SDK)

### Planned

#### Prio 1
- [ ] Test implementation (in-memory, with staged errors)
- [ ] Google Cloud Storage
- [ ] Azure Blob Storage

### Prio 2
- [ ] FTP (using `basic-ftp`)
- [ ] SFTP (?)

## Usage
Install the main package and any adapters you might need:

```bash
npm i -S @flystorage/file-storage

# for using AWS S3
npm i -S @flystorage/aws-s3

# for using the local filesystem
npm i -S @flystorage/local-fs
```

## Local Usage
```typescript
import {resolve} from 'node:path';
import {createReadStream} from 'node:fs';
import {FileStorage, Visibility} from '@flystorage/file-storage';
import {LocalFileStorage} from '@flystorage/local-fs';

// SETUP

const rootDirectory = resolve(process.cwd(), 'my-files');
const storage = new FileStorage(new LocalFileStorage(rootDirectory));

// USAGE

# Write using a string
await storage.write('write-from-a-string.txt', 'file contents');

# Write using a stream
const stream = createReadStream(resolve('process.cwd(), 'test-files/picture.png'));
await storage.write('picture.png', stream);

# Write with visibility (permissions).
await storage.write('public.txt', 'debug', {
    visibility: Visibility.PUBLIC, // mode: 0o644
});
await storage.write('private.txt', 'debug', {
    visibility: Visibility.PRIVATE, // mode: 0o644
});

# List directory contents
const contentsAsAsyncGenerator = storage.list('', {deep: true});

for await (const item of contentsAsAsyncGenerator) {
    console.log(item.path);

    if (item.isFile) {
        // do something with the file
    } else if (item.isDirectory) {
        // do something with the directory
    }
}

# Delete a file
await storage.deleteFile('some-file.txt');

# Delete a directory (with all contents)
await storage.deleteDirectory('some-directory');
```

## Author
Flystorage is built by the maintainer of [Flysystem](https://flysystem.thephpleague.com), a
filesystem abstraction for PHP. This brings along more than
a decade of smoothing over filesystem implementation differences
and weighing trade-offs to make a usable API.