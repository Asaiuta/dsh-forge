#!/usr/bin/env python3
"""Minimal reader for an Electron .asar archive (read-only).

The installed DSH ships as app.asar, and "verify the host before adapting to it"
means reading what is actually there rather than trusting a lockfile. asar is a
trivial container: 8 bytes of header sizes, then a JSON directory tree whose
file entries carry an offset into the payload.
"""
import json
import struct
import sys
from pathlib import Path


class Asar:
    def __init__(self, path):
        self.path = Path(path)
        with self.path.open('rb') as fh:
            head = fh.read(16)
            # Electron writes four u32s, then the JSON at 16. The exact JSON
            # length is the last of them; the payload begins after the padded
            # header, so the base is derived from the padded size, not the JSON.
            sizes = struct.unpack('<4I', head)
            # u32[1] is the aligned header size; the payload starts 8 bytes in.
            self.header_size = sizes[1]
            json_len = sizes[3]
            self.base = 8 + self.header_size
            fh.seek(16)
            raw = fh.read(json_len)
        self.index = json.loads(raw.decode('utf-8'))

    def _walk(self, parts):
        node = self.index
        for part in parts:
            if node.get('files') is None or part not in node['files']:
                return None
            node = node['files'][part]
        return node

    def stat(self, path):
        return self._walk([p for p in path.split('/') if p])

    def read(self, path):
        node = self.stat(path)
        if node is None or node.get('size') is None:
            return None
        with self.path.open('rb') as fh:
            fh.seek(self.base + int(node['offset']))
            return fh.read(int(node['size']))

    def ls(self, path=''):
        node = self.stat(path) if path else self.index
        if node is None or node.get('files') is None:
            return []
        return sorted(node['files'])

    def walk(self, prefix=''):
        node = self.stat(prefix) if prefix else self.index
        if node is None:
            return
        if node.get('files') is None:
            yield prefix, node
            return
        for name in sorted(node['files']):
            child = f'{prefix}/{name}' if prefix else name
            yield from self.walk(child)


if __name__ == '__main__':
    asar = Asar(sys.argv[1])
    if len(sys.argv) == 2:
        for name in asar.ls(''):
            print(name)
    elif sys.argv[2] == 'ls':
        for name in asar.ls(sys.argv[3] if len(sys.argv) > 3 else ''):
            print(name)
    elif sys.argv[2] == 'cat':
        data = asar.read(sys.argv[3])
        sys.stdout.write('(missing)\n' if data is None else data.decode('utf-8', 'replace'))
    elif sys.argv[2] == 'find':
        needle = sys.argv[3].lower()
        for name, node in asar.walk():
            if needle in name.lower():
                print(name, node.get('size', ''))
