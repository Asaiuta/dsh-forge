"""Standalone fresh-process Python callable runner; no source extraction/eval."""
import asyncio
import hashlib
import importlib
import importlib.util
import inspect
import json
import math
import os
import sys
import traceback

request = json.load(sys.stdin)
protocol_stdout = sys.stdout
count = 0


def encode(value, stack=None, depth=0):
    global count
    count += 1
    if count > 50000 or depth > 100:
        raise ValueError('result exceeds structural limit')
    if value is None:
        return {'type': 'null'}
    if type(value) in (str, bool):
        return {'type': 'string' if type(value) is str else 'boolean', 'value': value}
    if type(value) is int:
        return {'type': 'integer', 'value': str(value)}
    if type(value) is float:
        special = not math.isfinite(value) or (value == 0 and math.copysign(1, value) < 0)
        return {'type': 'number', 'value': str(value) if special else value}
    if type(value) not in (dict, list, tuple):
        raise ValueError('unsupported result type: ' + type(value).__name__)
    stack = set() if stack is None else stack
    if id(value) in stack:
        raise ValueError('cyclic result')
    stack.add(id(value))
    if type(value) is dict:
        if any(type(k) is not str for k in value):
            raise ValueError('dictionary keys must be strings')
        result = {'type': 'object', 'entries': [[k, encode(v, stack, depth + 1)] for k, v in value.items()]}
    else:
        result = {'type': 'tuple' if type(value) is tuple else 'array', 'items': [encode(v, stack, depth + 1) for v in value]}
    stack.remove(id(value))
    return result


def digest():
    with open(request['file'], 'rb') as stream:
        return hashlib.sha256(stream.read()).hexdigest()


async def run():
    if digest() != request['snapshot']:
        raise ValueError('source changed before import')
    file = request['file']
    parts = [] if os.path.basename(file) == '__init__.py' else [os.path.splitext(os.path.basename(file))[0]]
    directory = os.path.dirname(file)
    while os.path.isfile(os.path.join(directory, '__init__.py')):
        parts.insert(0, os.path.basename(directory))
        directory = os.path.dirname(directory)
    sys.path.insert(0, directory)
    if len(parts) > 1 or os.path.basename(file) == '__init__.py':
        module = importlib.import_module('.'.join(parts))
    else:
        spec = importlib.util.spec_from_file_location('_forge_target', file)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    if os.path.realpath(module.__file__) != os.path.realpath(file):
        raise ValueError('import resolved to another module')
    target = module
    for name in request['symbol'].split('.'):
        target = getattr(target, name)
    if not callable(target) or not hasattr(target, '__code__'):
        raise ValueError('symbol is not a Python function; use an explicit wrapper')
    code = target.__code__
    if os.path.realpath(code.co_filename) != os.path.realpath(file) or not request['firstLine'] <= code.co_firstlineno <= request['lastLine']:
        raise ValueError('runtime callable does not match selected declaration')
    args = request['args']
    if request.get('setup') is not None:
        namespace = {}
        exec('async def _prepare():\n' + '\n'.join('    ' + line for line in request['setup'].splitlines()), namespace)
        args = await namespace['_prepare']()
        if type(args) is not list:
            raise ValueError('setup must return an argument list')
    value = target(*args, **request.get('kwargs', {}))
    if inspect.isawaitable(value):
        value = await value
    if digest() != request['snapshot']:
        raise ValueError('source changed during execution')
    try:
        result = {'status': 'returned', 'value': encode(value)}
        if len(json.dumps(result, ensure_ascii=True).encode()) > 1024 * 1024:
            raise ValueError('result exceeds 1 MiB')
        return result
    except Exception as error:
        return {'status': 'unserializable', 'message': str(error)}


try:
    result = asyncio.run(run())
except BaseException:
    result = {'status': 'threw', 'message': traceback.format_exc()[-65536:]}
result['runtime'] = sys.version.split()[0]
protocol_stdout.write('\n' + request['marker'] + json.dumps(result, ensure_ascii=True) + '\n')
protocol_stdout.flush()
