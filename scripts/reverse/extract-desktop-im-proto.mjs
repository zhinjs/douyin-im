#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import descriptor from 'protobufjs/ext/descriptor/index.js';

const DEFAULT_BINARY =
  '/Applications/抖音聊天.app/Contents/Resources/libimcppsdk.dylib';

const TYPE_NAMES = Object.freeze({
  TYPE_DOUBLE: 'double',
  TYPE_FLOAT: 'float',
  TYPE_INT64: 'int64',
  TYPE_UINT64: 'uint64',
  TYPE_INT32: 'int32',
  TYPE_FIXED64: 'fixed64',
  TYPE_FIXED32: 'fixed32',
  TYPE_BOOL: 'bool',
  TYPE_STRING: 'string',
  TYPE_BYTES: 'bytes',
  TYPE_UINT32: 'uint32',
  TYPE_SFIXED32: 'sfixed32',
  TYPE_SFIXED64: 'sfixed64',
  TYPE_SINT32: 'sint32',
  TYPE_SINT64: 'sint64',
});

function readVarint(buffer, start) {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < buffer.length && shift < 35; offset += 1) {
    const byte = buffer[offset];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset + 1 };
    shift += 7;
  }
  throw new Error(`invalid varint at offset ${start}`);
}

function findDescriptor(buffer, filename) {
  const name = Buffer.from(filename);
  for (let offset = 0; offset < buffer.length - name.length - 2; offset += 1) {
    if (buffer[offset] !== 0x0a) continue;
    let length;
    try {
      length = readVarint(buffer, offset + 1);
    } catch {
      continue;
    }
    if (length.value !== name.length) continue;
    if (!buffer.subarray(length.next, length.next + name.length).equals(name)) continue;

    let end = length.next + name.length;
    while (end < buffer.length && buffer[end] !== 0) {
      const tag = readVarint(buffer, end);
      const field = tag.value >>> 3;
      const wire = tag.value & 7;
      if (field === 0 || field > 20 || ![0, 1, 2, 5].includes(wire)) break;
      end = tag.next;
      if (wire === 0) end = readVarint(buffer, end).next;
      else if (wire === 1) end += 8;
      else if (wire === 5) end += 4;
      else {
        const size = readVarint(buffer, end);
        end = size.next + size.value;
      }
    }
    return descriptor.FileDescriptorProto.toObject(
      descriptor.FileDescriptorProto.decode(buffer.subarray(offset, end)),
      { longs: String, enums: String, defaults: false },
    );
  }
  throw new Error(`${filename} descriptor not found`);
}

function shortType(typeName) {
  return typeName?.replace(/^\.im_proto\./, '');
}

function scalarType(field) {
  return shortType(field.typeName) || TYPE_NAMES[field.type];
}

function quoteDefault(field, value) {
  if (field.type === 'TYPE_STRING' || field.type === 'TYPE_BYTES') {
    return JSON.stringify(value);
  }
  return value;
}

function renderEnum(value, indent = '') {
  const lines = [`${indent}enum ${value.name} {`];
  for (const member of value.value ?? []) {
    lines.push(`${indent}  ${member.name} = ${member.number};`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

function renderMessage(message) {
  const maps = new Map(
    (message.nestedType ?? [])
      .filter((nested) => nested.options?.mapEntry || nested.options?.map_entry)
      .map((nested) => [nested.name, nested]),
  );
  const lines = [`message ${message.name} {`];
  for (const nested of message.nestedType ?? []) {
    if (maps.has(nested.name)) continue;
    lines.push(
      ...renderMessage(nested)
        .split('\n')
        .map((line) => `  ${line}`),
      '',
    );
  }
  for (const field of message.field ?? []) {
    const nestedName = shortType(field.typeName)?.split('.').at(-1);
    const map = nestedName ? maps.get(nestedName) : undefined;
    let declaration;
    if (map) {
      const [key, value] = map.field;
      declaration = `map<${scalarType(key)}, ${scalarType(value)}> ${field.name}`;
    } else {
      const label = field.label?.replace('LABEL_', '').toLowerCase() ?? 'optional';
      const type = scalarType(field).replace(`${message.name}.`, '');
      declaration = `${label} ${type} ${field.name}`;
    }
    const options = [];
    if (field.defaultValue !== undefined) {
      options.push(`default = ${quoteDefault(field, field.defaultValue)}`);
    }
    lines.push(`  ${declaration} = ${field.number}${options.length ? ` [${options.join(', ')}]` : ''};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function render(files) {
  const lines = [
    '// Generated from Douyin Chat 1.2.1 native descriptors and Frontier renderer codec.',
    '// Protocol schema only; presence here does not expose an SDK capability.',
    'syntax = "proto2";',
    'package im_proto;',
    '',
    'option java_package = "com.bytedance.im.core.proto";',
    'option java_outer_classname = "IMAPI";',
    'option objc_class_prefix = "TIMPBN";',
  ];
  for (const file of files) {
    lines.push('', `// ---- ${file.name} ----`);
    for (const value of file.enumType ?? []) lines.push('', renderEnum(value));
    for (const message of file.messageType ?? []) lines.push('', renderMessage(message));
  }
  return `${lines.join('\n')}\n`;
}

function addFrontierFrameFields(file) {
  const frame = file.messageType?.find((message) => message.name === 'Frame');
  if (!frame) throw new Error('Frame message not found in frame.proto descriptor');
  const additions = [
    ['log_id_new', 9, 'TYPE_STRING'],
    ['server_timing', 10, 'TYPE_STRING'],
    ['msg_id', 11, 'TYPE_STRING'],
    ['frame_type', 12, 'TYPE_INT32'],
  ];
  for (const [name, number, type] of additions) {
    if (frame.field?.some((field) => field.number === number)) continue;
    frame.field ??= [];
    frame.field.push({ name, number, type, label: 'LABEL_OPTIONAL' });
  }
  return file;
}

const binary = readFileSync(process.argv[2] ?? DEFAULT_BINARY);
process.stdout.write(render([
  // libimcppsdk.dylib carries fields 1-8. The app's renderer Frontier codec
  // explicitly encodes/decodes fields 9-12, so merge both first-party sources.
  addFrontierFrameFields(findDescriptor(binary, 'frame.proto')),
  findDescriptor(binary, 'im_api.proto'),
]));
