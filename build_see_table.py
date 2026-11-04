#!/usr/bin/env python
"""Pre-compute the pyCELP statistical-equilibrium (SEE) table for the Fe XIII Stokes Explorer.

pyCELP's emission coefficients for Fe XIII 10747 / 10798 A (Schad & Dima 2020, Eqs. 3, 6-8;
pycelp.emissionLine.calc_PolEmissCoeff) need only two numbers per line from the SEE solution:

    C     = h nu / (4 pi) * A_ul * N_u      [erg cm^-3 s^-1 sr^-1]  (emissionLine.C_coeff)
    sigma = rho^2_0 / rho^0_0 (upper level)                         (emissionLine.upper_level_alignment)

For pyCELP's cylindrically symmetric photospheric radiation field (no atomic coherences), the SEE
depends on (n_e, T_e, height, theta_B) only, and on theta_B only through cos^2(theta_B)
(pycelp.util.rad_field_bframe uses P2(cos theta_B)). Therefore:
  * theta_B and 180 - theta_B are identical, so we tabulate mu2 = cos^2(theta_B) in [0, 1];
  * |B|, the line of sight, and the Q/U reference direction never enter the SEE; the browser
    applies them analytically.

The table is written as a JavaScript file (globalThis.FE13_SEE_TABLE = {...}) so that the page also
works when opened directly from disk (file://), where fetch() of local JSON is blocked.

Usage (in the `sunpy` conda env):
    python build_see_table.py                                   # all CHIANTI levels (749)
    python build_see_table.py --nlevels 100 --out fe13_see_table_100.js
"""
import argparse
import base64
import contextlib
import datetime
import io
import json
import multiprocessing as mp
import os
import subprocess
import time

# keep each worker single-threaded (must be set before numpy is imported)
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
           "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LINES = [  # (key, approximate air wavelength [A] passed to Ion.get_emissionLine)
    ("1074", 10747.0),
    ("1079", 10798.0),
]

_ION = None


def _quiet(func, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()):
        return func(*args, **kwargs)


def _init_worker(nlevels, abund_file):
    global _ION
    import pycelp
    _ION = _quiet(pycelp.Ion, "fe_13", nlevels=nlevels, abundFile=abund_file)


def _solve(edens, etemp, height, thetab_deg):
    """Return [C_1074, sigma_1074, C_1079, sigma_1079] from one pyCELP SEE solution."""
    _quiet(_ION.calc_rho_sym, edens, etemp, height, thetab_deg)
    out = []
    for _, wv in LINES:
        ln = _ION.get_emissionLine(wv)
        out += [ln.C_coeff, ln.upper_level_alignment]
    return out


def _row_task(args):
    """Solve one (n_e, h) row for every mu2 node."""
    i_ne, i_h, edens, etemp, height, thetab_list = args
    return i_ne, i_h, np.array([_solve(edens, etemp, height, th) for th in thetab_list])


def _point_task(args):
    edens, etemp, height, thetab = args
    return _solve(edens, etemp, height, thetab)


def _line_constants(nlevels, abund_file):
    import pycelp
    ion = _quiet(pycelp.Ion, "fe_13", nlevels=nlevels, abundFile=abund_file)
    _quiet(ion.calc_rho_sym, 1e8, 2e6, 0.1, 30.0)
    consts = []
    for key, wv in LINES:
        ln = ion.get_emissionLine(wv)
        consts.append(dict(
            key=key,
            wv_air=float(ln.wavelength_in_air), wv_vac=float(ln.wavelength_in_vacuum),
            geff=float(ln.geff), D=float(ln.Dcoeff), E=float(ln.Ecoeff),
            A=float(ln.Einstein_A), Ju=float(ln.Jupp), Jl=float(ln.Jlow),
            upper=str(ln.upper_level_config).strip(), lower=str(ln.lower_level_config).strip(),
        ))
    return ion.nlevels, float(ion.atomicWeight), consts


def trilinear(table, grid, log_ne, log_h, mu2):
    """Reference implementation of the interpolation done in stokes_model.js."""
    idx = []
    for name, x in (("log10_ne", log_ne), ("log10_h", log_h), ("mu2", mu2)):
        g = grid[name]
        f = np.clip((x - g["start"]) / g["step"], 0, g["n"] - 1)
        i0 = min(int(np.floor(f)), g["n"] - 2)
        idx.append((i0, f - i0))
    (a, fa), (b, fb), (c, fc) = idx
    out = 0.0
    for da, wa in ((0, 1 - fa), (1, fa)):
        for db, wb in ((0, 1 - fb), (1, fb)):
            for dc, wc in ((0, 1 - fc), (1, fc)):
                out = out + wa * wb * wc * table[a + da, b + db, c + dc]
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--nlevels", type=int, default=None, help="levels in the Fe XIII model (default: all)")
    p.add_argument("--log-te", type=float, default=6.3, help="log10 electron temperature [K]")
    p.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    p.add_argument("--validate", type=int, default=64, help="random off-grid points to check interpolation")
    env_xuvtop = os.environ.get("XUVTOP", "")
    p.add_argument("--xuvtop", help="CHIANTI dbase directory (default: $XUVTOP if valid, else the notebook's path)",
                   default=env_xuvtop if os.path.isfile(os.path.join(env_xuvtop, "VERSION"))
                   else "/Users/yjzhu/ssw/packages/chianti/dbase/")
    p.add_argument("--abund", default="sun_coronal_2021_chianti.abund")
    p.add_argument("--out", default=os.path.join(HERE, "fe13_see_table.js"))
    args = p.parse_args()

    os.environ["XUVTOP"] = args.xuvtop
    abund_file = os.path.join(args.xuvtop, "abundance", args.abund)
    etemp = 10.0 ** args.log_te

    # ---- grid: uniform in log10(n_e), log10(h) and mu2 = cos^2(theta_B) ----
    # Spacing chosen from midpoint-error tests: n_e dominates the interpolation error, while the
    # solution is almost exactly linear in mu2 (the radiation-field anisotropy enters as P2(cos theta_B)),
    # so 11 mu2 nodes suffice.
    grid = {
        "log10_ne": dict(start=7.0, step=0.1, n=31),                                 # 1e7 .. 1e10 cm^-3
        "log10_h": dict(start=float(np.log10(0.005)), step=float((np.log10(1.5) - np.log10(0.005)) / 39), n=40),
        "mu2": dict(start=0.0, step=0.1, n=11),                                      # theta_B 90 .. 0 deg
    }
    nodes = {k: g["start"] + g["step"] * np.arange(g["n"]) for k, g in grid.items()}
    thetab_nodes = np.degrees(np.arccos(np.sqrt(np.clip(nodes["mu2"], 0, 1))))

    print(f"pycelp Fe XIII SEE table: nlevels={args.nlevels or 'all'}, log Te={args.log_te}, "
          f"grid {grid['log10_ne']['n']} x {grid['log10_h']['n']} x {grid['mu2']['n']} "
          f"= {np.prod([g['n'] for g in grid.values()])} solves, {args.workers} workers", flush=True)
    nlevels, atomic_weight, consts = _line_constants(args.nlevels, abund_file)

    tasks = [(i, j, 10.0 ** nodes["log10_ne"][i], etemp, 10.0 ** nodes["log10_h"][j], thetab_nodes)
             for i in range(grid["log10_ne"]["n"]) for j in range(grid["log10_h"]["n"])]
    shape = (grid["log10_ne"]["n"], grid["log10_h"]["n"], grid["mu2"]["n"])
    data = np.zeros(shape + (4,))

    rng = np.random.default_rng(2020)
    val_pts = np.column_stack([
        rng.uniform(nodes["log10_ne"][0], nodes["log10_ne"][-1], args.validate),
        rng.uniform(nodes["log10_h"][0], nodes["log10_h"][-1], args.validate),
        rng.uniform(0, 1, args.validate),
    ])

    t0 = time.time()
    with mp.get_context("spawn").Pool(args.workers, initializer=_init_worker,
                                      initargs=(args.nlevels, abund_file)) as pool:
        for n, (i, j, row) in enumerate(pool.imap_unordered(_row_task, tasks), 1):
            data[i, j] = row
            if n % max(1, len(tasks) // 20) == 0 or n == len(tasks):
                el = time.time() - t0
                print(f"  {n}/{len(tasks)} rows  {el/60:5.1f} min elapsed, "
                      f"~{el/n*(len(tasks)-n)/60:5.1f} min left", flush=True)
        direct = np.array(pool.map(_point_task, [
            (10.0 ** a, etemp, 10.0 ** b, float(np.degrees(np.arccos(np.sqrt(c))))) for a, b, c in val_pts]))

    log10C = np.log10(data[..., 0::2])   # (..., 2 lines)
    sigma = data[..., 1::2]

    # ---- interpolation check (same scheme as the browser) ----
    report = {}
    for k, (key, _) in enumerate(LINES):
        dC, dS = [], []
        for (a, b, c), d in zip(val_pts, direct):
            Ci = 10.0 ** trilinear(log10C[..., k], grid, a, b, c)
            Si = trilinear(sigma[..., k], grid, a, b, c)
            dC.append(abs(Ci / d[2 * k] - 1))
            dS.append(abs(Si - d[2 * k + 1]))
        report[key] = dict(max_rel_err_C=float(np.max(dC)), max_abs_err_sigma=float(np.max(dS)),
                           max_abs_sigma=float(np.max(np.abs(sigma[..., k]))))
        print(f"  interpolation check {key}: max |dC/C| = {np.max(dC):.2e}, "
              f"max |d sigma| = {np.max(dS):.2e} (max |sigma| in table {np.max(np.abs(sigma[..., k])):.3f})")

    def b64(a):
        return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")

    try:
        commit = subprocess.run(["git", "-C", os.path.dirname(__import__("pycelp").__file__), "rev-parse",
                                 "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    except Exception:
        commit = ""
    try:
        chianti = open(os.path.join(args.xuvtop, "VERSION")).read().strip()
    except OSError:
        chianti = ""

    out = dict(
        meta=dict(
            generator="build_see_table.py", created=datetime.date.today().isoformat(),
            ion="fe_13", nlevels=nlevels, pycelp_commit=commit, chianti_version=chianti,
            abundance_file=args.abund, ioneq="CHIANTI default (chianti.ioneq)",
            include_limbdark=True, include_protons=True, proton_to_electron=0.85,
            log10_Te=args.log_te, interpolation_check=report,
            layout="arrays are float32 little-endian, C-order [log10_ne, log10_h, mu2]",
        ),
        grid=grid, Te=etemp, atomic_weight=atomic_weight,
        lines=[dict(**c, log10C=b64(log10C[..., k]), sigma=b64(sigma[..., k])) for k, c in enumerate(consts)],
    )
    with open(args.out, "w") as f:
        f.write("/* Fe XIII statistical-equilibrium table for the Stokes Explorer.\n"
                f"   Generated by build_see_table.py on {out['meta']['created']} with pycelp {commit}, "
                f"{nlevels} levels. Do not edit by hand. */\n")
        f.write("globalThis.FE13_SEE_TABLE = ")
        json.dump(out, f, separators=(",", ":"))
        f.write(";\n")
    print(f"wrote {args.out} ({os.path.getsize(args.out)/1e6:.2f} MB) in {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
