import codecs

with codecs.open('prompt.txt', 'r', 'utf-16le') as f:
    lines = f.readlines()

p6_idx = -1
p7_idx = -1

for i, l in enumerate(lines):
    if 'Prompt 6' in l:
        p6_idx = i
    if 'Prompt 7' in l:
        p7_idx = i

if p6_idx != -1 and p7_idx != -1:
    print(''.join(lines[p6_idx:p7_idx]))
