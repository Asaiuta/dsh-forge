# Operator tools

## `asar-read.py` — read an installed DSH without unpacking it

M1.4 requires verifying the **installed** host rather than a lockfile: the
desktop app ships its whole dependency tree inside `resources/app.asar`, so the
version and the symbols that actually run are only visible there. Extracting
192 MB to read two files is worse than reading the container, and `npx asar`
would add a dependency to answer a question that takes thirty lines.

```sh
python tools/asar-read.py "F:/DSH-NEXT/DSH NEXT/resources/app.asar" ls
python tools/asar-read.py ".../app.asar" cat node_modules/@deepseek-ai/dsh-tools/package.json
python tools/asar-read.py ".../app.asar" find dsh-user-approval
```

Format notes, because both are easy to get wrong and produce garbage rather than
an error:

- Bytes 0–15 are four little-endian u32s: `4`, the **aligned** header size, the
  padded payload size, and the exact JSON length.
- The JSON starts at byte 16 and runs for the **fourth** value, not the second.
- File payload offsets are relative to `8 + header_size`, not `16 + header_size`.
