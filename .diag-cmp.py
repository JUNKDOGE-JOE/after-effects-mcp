import struct, sys

def extract_pipl(path):
    b = open(path, 'rb').read()
    pe = struct.unpack_from('<I', b, 0x3c)[0]
    opt = pe + 24
    optsz = struct.unpack_from('<H', b, pe + 20)[0]
    nrsrc, _ = struct.unpack_from('<II', b, opt + 112 + 16)
    secs = {}
    cur = opt + optsz
    for i in range(struct.unpack_from('<H', b, pe + 6)[0]):
        name = b[cur:cur + 8].split(b'\0')[0].decode('ascii', 'replace')
        vs, va, rs, rp = struct.unpack_from('<IIII', b, cur + 8)
        secs[name] = (va, max(vs, rs), rp)
        cur += 40
    def rva2off(rva, size=16):
        for va, span, rp in secs.values():
            if va <= rva and rva + size <= va + span:
                return rp + (rva - va)
        return None
    base = rva2off(nrsrc)
    if base is None:
        return None
    def walk(off, depth, want):
        named, ids = struct.unpack_from('<HH', b, off + 12)
        cur = off + 16
        for _ in range(named + ids):
            rawn, rawt = struct.unpack_from('<II', b, cur)
            cur += 8
            name = rawn & 0xffff
            if rawn & 0x80000000:
                so = base + (rawn & 0x7fffffff)
                ln = struct.unpack_from('<H', b, so)[0]
                name = b[so + 2:so + 2 + ln * 2].decode('utf-16le', 'replace')
            isdir = bool(rawt & 0x80000000)
            tgt = rawt & 0x7fffffff
            if depth == 0:
                print(f'  [{path.split(chr(92))[-1]}] type: {name!r}')
                if isinstance(name, str) and name.upper() == want:
                    return walk(base + tgt, depth + 1, want)
            elif depth == 1:
                print(f'    id: {name}')
                if isdir:
                    r = walk(base + tgt, depth + 1, want)
                    if r is not None:
                        return r
            else:
                drva, dsz = struct.unpack_from('<II', b, base + tgt)
                doff = rva2off(drva, dsz)
                return b[doff:doff + dsz]
        return None
    return walk(base, 0, 'PIPL')

ours = extract_pipl(sys.argv[1])
theirs = extract_pipl(sys.argv[2])
for label, p in (('OURS', ours), ('THEIRS', theirs)):
    if p is None:
        print(label, 'no PiPL')
        continue
    print(label, len(p), 'bytes:', p[:min(len(p), 160)].hex(' '))
