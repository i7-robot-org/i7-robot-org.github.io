#!/usr/bin/env python3
"""Colour the i7 meshes like the real robot (photos in docs/manual/index.html, section 1).

The vendor STLs carry no materials, but each link mesh is an assembly of separate shells
(arm covers, joint rings, gripper fingers, head, screen, wheels...). This script splits every
link into its connected parts, gives each part a material by where it sits in the link frame,
then sorts the triangles by material and stores the ranges as `g: [[start, count, material], ...]`
(base_link names carry a region too, e.g. `shell@chassis`). i7sim.js turns those ranges into geometry groups. Run it after convert_meshes.mjs:

  python3 paint_mesh.py i7_mesh.json
"""
import base64
import json
import sys

import numpy as np

MATERIALS = ['shell', 'joint', 'graphite', 'black', 'rubber', 'blue', 'silver', 'camera', 'red', 'lidar']


def load(v):
    p = np.frombuffer(base64.b64decode(v['p']), dtype=np.float32).reshape(-1, 3)
    i = np.frombuffer(base64.b64decode(v['i']), dtype=np.uint32 if v.get('i32') else np.uint16).reshape(-1, 3)
    return p, i.astype(np.int64)


def parts(p, i):
    """Connected parts, counting coincident vertices (STL seams) as connected. Returns a part id per triangle."""
    par = np.arange(len(p))

    def find(a):
        r = a
        while par[r] != r:
            r = par[r]
        while par[a] != r:
            par[a], a = r, par[a]
        return r

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            par[rb] = ra
    for a, b, c in i:
        union(a, b); union(a, c)
    seen = {}
    for k, q in enumerate(map(tuple, np.round(p, 5))):
        if q in seen:
            union(seen[q], k)
        else:
            seen[q] = k
    roots = np.array([find(a) for a in i[:, 0]])
    return np.unique(roots, return_inverse=True)[1]


def paint_link(name, p, i):
    """Material name per triangle (None drops the triangle)."""
    pid = parts(p, i)
    tri = p[i]                                           # (n, 3, 3)
    cz = tri[:, :, 2].mean(1)
    out = np.empty(len(i), dtype=object)
    size = np.bincount(pid)
    for c in range(pid.max() + 1):
        sel = pid == c
        q = p[np.unique(i[sel].ravel())]
        mn, mx = q.min(0), q.max(0)
        ext = mx - mn
        biggest = size[c] == size.max()
        m = 'shell'
        if name == 'base_link':
            if mn[0] > 0.04 and 0.12 < mn[2] and mx[2] < 0.19:
                m = 'black'                                          # front depth camera
            elif mx[2] < 0.18 and ext[0] < 0.15 and ext[1] < 0.12:
                m = 'rubber'                                         # drive wheels and casters
            elif mx[0] < -0.52 and mx[2] < 0.25:
                m = 'black'                                          # rear vent
            elif 0.27 < mn[2] and mx[2] < 0.35 and max(ext) < 0.07:
                m = 'lidar'                                          # lidar and its dome, front-left and rear-right deck corners
            elif mn[2] > 0.5 and ext[2] > 0.6 and mx[1] < 0.1 and mn[1] > -0.1 and mn[0] > -0.25:
                m = 'graphite'                                       # ribbed strip down the column front
            elif mx[0] < -0.37 and 1.2 < mn[2] and mx[2] < 1.4 and ext[1] > 0.15:
                m = 'black' if size[c] > 100 else 'graphite'         # rear screen and its bezel
            elif mn[0] < -0.33 and mx[0] < -0.3 and 1.0 < mn[2] < 1.26 and max(ext) < 0.08:
                m = 'red' if mx[2] < 1.15 else ('silver' if max(ext) < 0.04 else 'shell')   # e-stop, key switch, panel
            elif mn[2] > 1.43 and ext[1] > 0.2:
                m = None                                             # head box: simplification crumples it, i7sim.js rebuilds it
            elif mn[2] > 1.45:
                m = 'black'                                          # head camera, microphones
        elif name == 'Shoulder_Base':
            if abs(mn[1] + mx[1]) / 2 > 0.08 and mx[2] < 0.08:
                m = 'graphite'                                       # black collars where the arms attach
            elif mn[2] > 0.26 and mn[0] > 0.03:
                m = 'black'                                          # stereo camera face and lenses
            elif mn[2] > 0.26 and mn[1] > 0.06:
                m = 'blue'                                           # camera end cap
            elif mn[2] > 0.26:
                m = 'camera'                                         # camera body
            elif ext[2] > 0.3:
                m = 'silver'                                         # camera mast
        elif name.startswith('Gripper'):
            m = 'shell' if biggest else 'black'                      # housing, linkage fingers
        elif name.startswith('falan'):
            if biggest and mn[0] > 0.05:
                m = 'camera'                                         # wrist camera block
            elif mn[0] < 0 and ext[0] > 0.1:
                m = 'shell'                                          # flange
            else:
                m = 'black'                                          # lens, cable
        elif name.startswith('Wrist_Yaw'):
            m = 'blue' if mn[2] > -0.025 else ('shell' if biggest else 'joint')
        elif name.startswith('Shoulder_Pitch'):
            m = 'shell' if biggest else 'graphite'                   # cap with the logo
        else:
            m = 'shell' if biggest or ext[2] > 0.09 else 'joint'     # covers; thin rings between them
        out[sel] = m
    if name == 'base_link':
        out[(out == 'shell') & (cz < 0.125)] = 'graphite'           # the chassis is dark below the white deck
    return out


def region_of(p, i):
    """'chassis' or 'column' per triangle of base_link, by the centre height of the part it belongs to."""
    pid = parts(p, i)
    cz = np.array([p[np.unique(i[pid == c].ravel())][:, 2].mean() for c in range(pid.max() + 1)])
    return np.where(cz[pid] < 0.36, 'chassis', 'column')


def main(path):
    d = json.load(open(path))
    for name, v in d.items():
        p, i = load(v)
        mats = paint_link(name, p, i)
        keep = mats != None                                              # noqa: E711 (object array)
        i, mats = i[keep], mats[keep]
        keys = [m for m in mats]
        if name == 'base_link':
            # the site's explorer highlights the chassis and the column separately, so base_link groups also carry
            # a region: material@chassis (below the deck top) or material@column
            region = region_of(p, i)
            keys = [f'{m}@{r}' for m, r in zip(mats, region)]
        names = sorted(set(keys), key=lambda k: (MATERIALS.index(k.split('@')[0]), k))
        idx = np.array([names.index(k) for k in keys])
        order = np.argsort(idx, kind='stable')
        i2 = i[order]
        groups = []
        for k, key in enumerate(names):
            n = int((idx == k).sum())
            start = int(np.searchsorted(idx[order], k)) * 3
            groups.append([start, n * 3, key])
        v['i'] = base64.b64encode(i2.astype(np.uint32 if v.get('i32') else np.uint16).tobytes()).decode()
        v['g'] = groups
        print(f'{name:22s}', ' '.join(f'{g[2]}:{g[1] // 3}' for g in groups))
    json.dump(d, open(path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'i7_mesh.json')
