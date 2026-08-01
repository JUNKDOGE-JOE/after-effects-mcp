import struct, sys

def read_res_pipl(path):
    b = open(path, 'rb').read()
    # .res format: sequence of [DataSize(4) HeaderSize(4) Type(4/ord or string) Name(4/ord) ...]
    off = 0
    while off + 8 <= len(b):
        data_size, header_size = struct.unpack_from('<II', b, off)
        if header_size == 0 and data_size == 0:
            break
        p = off + 8
        # Type: 0xFFFF + ord, or string (utf16)
        if struct.unpack_from('<H', b, p)[0] == 0xFFFF:
            rtype = struct.unpack_from('<H', b, p + 2)[0]
            p += 4
        else:
            end = b.find(b'\x00\x00', p)
            rtype = b[p:end].decode('utf-16le', 'replace')
            p = end + 2
        if struct.unpack_from('<H', b, p)[0] == 0xFFFF:
            rname = struct.unpack_from('<H', b, p + 2)[0]
            p += 4
        else:
            end = b.find(b'\x00\x00', p)
            rname = b[p:end].decode('utf-16le', 'replace')
            p = end + 2
        data_off = off + header_size
        data = b[data_off:data_off + data_size]
        print(f'type={rtype!r} name={rname!r} bytes={data_size}')
        if isinstance(rtype, str) and rtype.upper() == 'PIPL':
            return data
        off = data_off + data_size
        if off % 4:
            off += 4 - (off % 4)
    return None

data = read_res_pipl(sys.argv[1])
if data:
    print('PIPL bytes:', data.hex(' '))
