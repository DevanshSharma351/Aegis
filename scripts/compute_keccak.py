from Crypto.Hash import keccak
k = keccak.new(digest_bits=256)
k.update(b'MOCK_ENCLAVE_MEASUREMENT')
print(k.hexdigest())
