"""
离线标定：解码讲解音频，按 23 ms 窗（对应浏览器 fftSize=1024 @44.1k）算 RMS，
再模拟 audio.js 里的峰值跟随器 + 开口映射，检查开口量分布是否合理。

目标：说话时中位 0.40~0.55，p90 接近 1，峰值刚好贴 1（长期贴 1 就是过曝）。
"""
import array
import sys

SR = 16000
WIN = 384  # 24 ms

raw = open('/tmp/narr.raw', 'rb').read()
pcm = array.array('h')
pcm.frombytes(raw)
print(f'样本 {len(pcm)}  ({len(pcm)/SR:.1f} s)')

# 逐窗 RMS
rms = []
for i in range(0, len(pcm) - WIN, WIN):
    s = 0
    for j in range(i, i + WIN):
        v = pcm[j] / 32768.0
        s += v * v
    rms.append((s / WIN) ** 0.5)
print(f'窗数 {len(rms)}')


def pct(a, p):
    b = sorted(a)
    return b[min(len(b) - 1, max(0, int(len(b) * p)))]


sp = [v for v in rms if v > 0.004]
print(f'有声窗 {len(sp)}  占比 {len(sp)/len(rms)*100:.1f}%')
print('RMS 分位（仅有声）: ' + '  '.join(
    f'p{int(p*100)}={pct(sp, p):.4f}' for p in (0.05, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99)))
print(f'RMS max={max(sp):.4f}')


def simulate(gate_k, top_k, gamma=0.62, dt=0.024, gain=1.0, floor=0.055):
    """复现 audio.js：峰值跟随 → 归一化 → 非对称平滑"""
    ref = 0.22
    op = 0.0
    out = []
    for r in rms:
        if r > ref:
            ref += (r - ref) * min(1, dt / 0.30)
        else:
            ref += (r - ref) * min(1, dt / 6.0)
        ref = min(0.6, max(floor, ref))
        g = ref * gate_k
        t = ref * top_k
        o = min(1.0, max(0.0, (r - g) / max(1e-4, t - g)))
        o = (o ** gamma) * gain
        k = dt / 0.035 if o > op else dt / 0.115
        op += (o - op) * min(1, k)
        op = min(1.6, max(0.0, op))
        out.append(op)
    return out


print('\n候选参数（gate_k, top_k）→ 开口量分位')
best = None
for gk, tk in ((0.10, 0.95), (0.15, 1.00), (0.20, 1.05), (0.25, 1.10), (0.22, 1.05), (0.28, 1.15)):
    o = simulate(gk, tk)
    st = {f'p{int(p*100)}': pct(o, p) for p in (0.1, 0.25, 0.5, 0.75, 0.9, 0.99)}
    mean = sum(o) / len(o)
    sat = sum(1 for v in o if v > 0.99) / len(o) * 100
    print(f'  gate={gk:.2f} top={tk:.2f}  ' +
          '  '.join(f'{k}={v:.3f}' for k, v in st.items()) +
          f'  mean={mean:.3f}  饱和率={sat:.1f}%')
    score = abs(st['p50'] - 0.48) + abs(st['p90'] - 0.92) * 1.5 + sat / 100
    if best is None or score < best[0]:
        best = (score, gk, tk)

print(f'\n推荐 gate_k={best[1]:.2f}  top_k={best[2]:.2f}')
