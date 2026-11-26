#!/usr/bin/env python3
"""把 sfx/*.ogg 重新内联进 client.js 的 SFX_LIBRARY / SFX_DATA 块。

用法：
    python3 tools/build-sfx.py          # 重写 client.js 里的样本块
    python3 tools/build-sfx.py --check  # 只报告会变成什么，不改文件

样本命名约定：<类别>-<序号>.ogg，例如 pistol-1.ogg / rifle-2.ogg。
类别名会原样成为 SFX_LIBRARY 的键，client.js 按类别名做力度映射，
新增类别时记得同步 client.js 里的 fire() 映射表。

为什么内联而不是走宿主路由：宿主 index.js 的改动要重启整个 App 才生效，
而客户端 bundle 是热更的。内联才能做到「改完就响」，且插件自包含、不走网络。
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SFX_DIR = ROOT / 'sfx'
CLIENT = ROOT / 'client.js'

BEGIN = '/* @sfx-begin */'
END = '/* @sfx-end */'
LIB_RE = re.compile(r'( *)const SFX_LIBRARY = \{\n.*?\n( *)\};\n', re.S)
DATA_RE = re.compile(r'( *)' + re.escape(BEGIN) + r'.*?' + re.escape(END), re.S)
NAME_RE = re.compile(r'^([a-z0-9]+)-(\d+)\.ogg$')
# 类别顺序决定解码顺序，也决定 client.js 里 SFX_LIBRARY 的键序（测试按这个顺序打标签）：
# boom 是「长尾层」，roger 之后是多条按需解码的长录音；未列出的类别按字母序排在后面。
CATEGORY_ORDER = [
    'blast', 'wall', 'miss', 'ram', 'heavy', 'far', 'long', 'boom', 'roger',
    'siren', 'plane', 'radio',
]


def collect():
    """按类别分组，返回 [(kind, [file, ...]), ...]，序号按数值排序。"""
    groups = {}
    for path in sorted(SFX_DIR.glob('*.ogg')):
        m = NAME_RE.match(path.name)
        if not m:
            print(f'  ! 跳过不符合命名约定的文件：{path.name}', file=sys.stderr)
            continue
        groups.setdefault(m.group(1), []).append((int(m.group(2)), path.name))
    def rank(kind):
        return (CATEGORY_ORDER.index(kind), '') if kind in CATEGORY_ORDER else (len(CATEGORY_ORDER), kind)

    return [(kind, [n for _, n in sorted(files)]) for kind, files in sorted(groups.items(), key=lambda kv: rank(kv[0]))]


def render(groups):
    lib = ['    const SFX_LIBRARY = {']
    for kind, files in groups:
        lib.append(f"      {kind}: [{', '.join(repr(f) for f in files)}],")
    lib.append('    };')

    data = [BEGIN, '    const SFX_DATA = {']
    for _, files in groups:
        for name in files:
            b64 = base64.b64encode((SFX_DIR / name).read_bytes()).decode('ascii')
            data.append(f"      {name!r}: '{b64}',")
    data.extend(['    };', '    /* @sfx-end */'])
    return '\n'.join(lib) + '\n', '\n'.join(data)


def main():
    check = '--check' in sys.argv
    groups = collect()
    if not groups:
        sys.exit('sfx/ 里没有可用的 .ogg')
    total = sum((SFX_DIR / n).stat().st_size for _, fs in groups for n in fs)
    print(f'扫描到 {sum(len(f) for _, f in groups)} 个样本 / {total} 字节')
    for kind, files in groups:
        print(f'  {kind}: {len(files)} 个  {", ".join(files)}')

    lib, data = render(groups)
    src = CLIENT.read_text()
    new, n_lib = LIB_RE.subn(lib, src, count=1)
    if n_lib != 1:
        sys.exit('没找到 SFX_LIBRARY 块，client.js 结构变了？')
    new, n_data = DATA_RE.subn(lambda m: m.group(1) + data, new, count=1)
    if n_data != 1:
        sys.exit('没找到 @sfx-begin/@sfx-end 标记块')

    if new == src:
        print('client.js 已是最新，无需改动')
        return
    if check:
        print(f'--check：会改写 client.js（{len(src.encode())} → {len(new.encode())} 字节）')
        return
    CLIENT.write_text(new)
    print(f'client.js 已更新：{len(src.encode())} → {len(new.encode())} 字节')


if __name__ == '__main__':
    main()
