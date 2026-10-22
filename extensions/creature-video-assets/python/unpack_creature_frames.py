"""Bounded streaming extraction of production frame ZIPs, without loading the ZIP in RAM."""
import pathlib
import re
import shutil
import stat
import sys
import zipfile

archive, destination = map(pathlib.Path, sys.argv[1:3])
root = destination.resolve()
if archive.stat().st_size > 2 * 1024**3:
    raise ValueError("frame archive exceeds 2 GiB")
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if len(entries) > 20_000:
        raise ValueError("too many archive members")
    total = 0
    for entry in entries:
        name = entry.filename
        target = (root / name).resolve()
        if ("\\" in name or re.match(r"^[a-zA-Z]:", name)
                or ".." in pathlib.PurePosixPath(name).parts
                or root not in target.parents
                or stat.S_ISLNK(entry.external_attr >> 16)):
            raise ValueError("unsafe archive member")
        total += entry.file_size
        if entry.file_size > 64 * 1024**2 or total > 20 * 1024**3:
            raise ValueError("archive expansion exceeds limit")
    # zipfile verifies sizes and CRC while reading; never use extractall.
    for entry in entries:
        target = root / entry.filename
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(entry) as reader, target.open("xb") as writer:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
