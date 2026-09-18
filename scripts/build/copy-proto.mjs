#!/usr/bin/env node

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = new URL('../../src/services/im/proto/im.proto', import.meta.url);
const target = new URL('../../lib/services/im/proto/im.proto', import.meta.url);

await mkdir(dirname(fileURLToPath(target)), { recursive: true });
await copyFile(source, target);
