#!/usr/bin/env python3
"""Extract the dependency closure of selected packages from an Electron app.asar.

usage: asar_closure.py <app.asar> <out-dir> <pkg> [<pkg> ...]

Walks package.json dependencies/peerDependencies/optionalDependencies, resolving
each name the way Node does (nested node_modules first, then the top level), and
writes every file of every reached package under <out-dir>, mirroring the asar
layout. Files stored in app.asar.unpacked are skipped (printed at the end).
"""
import json
import os
import struct
import sys


def main():
    src, out, roots = sys.argv[1], sys.argv[2], sys.argv[3:]
    fh = open(src, 'rb')
    sizes = struct.unpack('<4I', fh.read(16))
    base = 8 + sizes[1]
    index = json.loads(fh.read(sizes[3]).decode('utf-8'))

    def node_at(path):
        node = index
        for part in [p for p in path.split('/') if p]:
            files = node.get('files')
            if files is None or part not in files:
                return None
            node = files[part]
        return node

    def read(path):
        node = node_at(path)
        if node is None or node.get('size') is None or node.get('unpacked'):
            return None
        fh.seek(base + int(node['offset']))
        return fh.read(int(node['size']))

    def resolve(name, from_dir):
        # from_dir is a package dir like node_modules/a/node_modules/b
        cur = from_dir
        while True:
            candidate = f'{cur}/node_modules/{name}' if cur else f'node_modules/{name}'
            if node_at(candidate) is not None:
                return candidate
            if not cur:
                return None
            # climb out of the current package dir
            parts = cur.split('/')
            if 'node_modules' not in parts:
                cur = ''
                continue
            idx = len(parts) - 1 - parts[::-1].index('node_modules')
            cur = '/'.join(parts[:idx])

    seen, queue, missing = set(), [], []
    for r in roots:
        p = resolve(r, '')
        if p is None:
            missing.append(r)
        else:
            queue.append(p)
    while queue:
        pkg = queue.pop()
        if pkg in seen:
            continue
        seen.add(pkg)
        raw = read(f'{pkg}/package.json')
        if raw is None:
            continue
        meta = json.loads(raw.decode('utf-8'))
        for field in ('dependencies', 'peerDependencies', 'optionalDependencies'):
            for dep in (meta.get(field) or {}):
                p = resolve(dep, pkg)
                if p is None:
                    if field != 'optionalDependencies':
                        missing.append(f'{dep} (from {pkg})')
                    continue
                if p not in seen:
                    queue.append(p)

    written, unpacked = 0, []

    def walk(node, path):
        nonlocal written
        files = node.get('files')
        if files is None:
            if node.get('unpacked'):
                unpacked.append(path)
                return
            if node.get('link'):
                return
            dest = os.path.join(out, *path.split('/'))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            fh.seek(base + int(node['offset']))
            with open(dest, 'wb') as w:
                w.write(fh.read(int(node['size'])))
            written += 1
            return
        for name, child in files.items():
            # nested node_modules are their own packages and are reached through resolution
            if name == 'node_modules' and path != '':
                continue
            walk(child, f'{path}/{name}')

    for pkg in sorted(seen):
        walk(node_at(pkg), pkg)
    print(f'packages {len(seen)}, files {written}')
    if missing:
        print('unresolved:', ', '.join(sorted(set(missing))[:40]))
    if unpacked:
        print('unpacked (not extracted):', len(unpacked), 'e.g.', unpacked[:5])


if __name__ == '__main__':
    main()
