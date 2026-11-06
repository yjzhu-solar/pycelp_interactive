#!/usr/bin/env python
"""Cut the telluric and solar atlases around Fe XIII 10747 / 10798 A for the Stokes Explorer.

The page's optional observation effects (telluric absorption, scattered photospheric light) need
two spectra near each coronal line, both continuum-normalized and on air wavelengths:

  T(lambda)  telluric transmission: US standard atmosphere, CO2 416 ppm, observer at 3 km,
             precipitable water vapour 3 mm, airmass 1, from T. Schad's DKIST telluric atlas
             (https://github.com/tschad/dkist_telluric_atlas, doi:10.5281/zenodo.13922153; files v20260407,
             HITRAN2024 line list, synthesized with Py4CAtS). File wavelengths are in air.
  S(lambda)  solar pseudo-transmittance spectrum of G. C. Toon (JPL), version 2020-07-20,
             disk-integrated ("_100"), https://mark4sun.jpl.nasa.gov/toon/solar/solar_spectrum.html.
             Columns are vacuum wavenumber [cm^-1] and transmittance; converted to air wavelength
             with the IAU (Morton 2000) formula.

Both are linearly resampled onto lambda_0 + [-HALF, +HALF] A in STEP-A steps, quantized to uint16
(1/65535 resolution), and written as obs_atlas.js (globalThis.FE13_OBS_ATLAS = {...}), so the
page also works from file://. lambda_0 is the rest air wavelength used for DKIST/Cryo-NIRSP data,
1074.65 and 1079.80 nm (--rest), not the CHIANTI value in fe13_see_table.js (1074.615, 1079.780 nm):
the page draws each coronal line at lambda_0 plus its Doppler shift, so this sets where the telluric
and photospheric features fall relative to the line.

The file also holds, for the Thomson-scattered K corona, the mean intensity J00 [erg cm^-2 s^-1 sr^-1 A^-1]
and the anisotropy omega of the limb-darkened photospheric radiation versus height at each lambda_0, from
pycelp.allenSolRad (J00_sym, get_omega), as used in pyCELP's Example_PSI_model_synthesis notebook.

Usage (in the `sunpy` conda env):
    python build_obs_atlas.py --atlas-dir /path/to/Cryo_Line_Artifact/atlas
"""
import argparse
import base64
import datetime
import gzip
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TELLURIC_WAVE = "telluric_atlas_mainMol_USstd_wv_air_angstrom_v20260407.npy"
TELLURIC_TRANS = "telluric_atlas_mainMol_USstd_CO2_416ppm-Base_3km-PWV_3__mm-Airmass_1___v20260407.npy"
SOLAR = "solar_merged_20200720_600_33300_100.out.gz"


def vac2air(wave_vac):
    """Vacuum to air wavelength [A] (IAU standard, Morton 2000), valid above 2000 A."""
    s2 = (1e4 / wave_vac) ** 2
    n = 1 + 0.0000834254 + 0.02406147 / (130 - s2) + 0.00015998 / (38.9 - s2)
    return wave_vac / n


def read_solar(path, wmin, wmax):
    """Rows of the Toon atlas inside [wmin, wmax] A (air); the file is read line by line."""
    smin, smax = 1e8 / (wmax * 1.0004), 1e8 / (wmin * 1.0001)   # generous vacuum-wavenumber bounds
    nu, tr = [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            parts = line.split()
            if len(parts) != 2:
                continue
            try:
                v = float(parts[0])
            except ValueError:
                continue
            if v < smin:
                continue
            if v > smax:
                break
            nu.append(v)
            tr.append(float(parts[1]))
    nu = np.array(nu)
    w = vac2air(1e8 / nu)[::-1]
    return w, np.array(tr)[::-1]


def thomson_tables(rest, h_lo=1e-3, h_hi=4.0, n=161):
    """J00 per Angstrom and omega of pyCELP's limb-darkened photospheric radiation, log-spaced in height [R_sun]."""
    import pycelp.allenSolRad as allen
    r_sun_km = 6.957e5                                   # allenSolRad.J00_sym's value
    c_ang = 2.99792458e18                                # A s^-1
    lh = np.linspace(np.log10(h_lo), np.log10(h_hi), n)
    out = []
    for wv in rest:
        h_km = 10 ** lh * r_sun_km
        J_nu, _ = allen.J00_sym(wv, h_km)                # erg cm^-2 s^-1 sr^-1 Hz^-1
        om = allen.get_omega(wv, h_km)
        out.append({"J00": [float(f"{v:.6e}") for v in J_nu * c_ang / wv ** 2],
                    "omega": [float(f"{v:.6f}") for v in om]})
    return {"log10_h": {"start": float(lh[0]), "step": float(lh[1] - lh[0]), "n": n},
            "units": "J00 in erg cm^-2 s^-1 sr^-1 A^-1; height in R_sun above the photosphere",
            "source": "pycelp.allenSolRad J00_sym / get_omega (Allen limb darkening)",
            "lines": out}


def b64_u16(x):
    q = np.round(np.clip(x, 0, 1) * 65535).astype("<u2")
    return base64.b64encode(q.tobytes()).decode("ascii")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--atlas-dir", default=os.path.join(HERE, "..", "..", "Cryo_Line_Artifact", "atlas"))
    p.add_argument("--rest", default="10746.5,10798.0", help="rest air wavelengths of the 1074 and 1079 lines [A]")
    p.add_argument("--half", type=float, default=25.0, help="half width of each window [A]")
    p.add_argument("--step", type=float, default=0.01, help="sampling [A]")
    p.add_argument("--out", default=os.path.join(HERE, "obs_atlas.js"))
    args = p.parse_args()

    lines = list(zip(("1074", "1079"), (float(v) for v in args.rest.split(","))))
    n = int(round(2 * args.half / args.step)) + 1
    dl = -args.half + args.step * np.arange(n)
    wmin = min(c for _, c in lines) - args.half - 1
    wmax = max(c for _, c in lines) + args.half + 1

    wt = np.load(os.path.join(args.atlas_dir, TELLURIC_WAVE), allow_pickle=True).astype(float)
    tt = np.load(os.path.join(args.atlas_dir, TELLURIC_TRANS), allow_pickle=True).astype(float)
    m = (wt > wmin) & (wt < wmax)
    wt, tt = wt[m], tt[m]
    ws, ss = read_solar(os.path.join(args.atlas_dir, SOLAR), wmin, wmax)
    print(f"telluric: {wt.size} samples, median step {np.median(np.diff(wt)):.4f} A; "
          f"solar: {ws.size} samples, median step {np.median(np.diff(ws)):.4f} A")

    out_lines = []
    for key, c in lines:
        T = np.interp(c + dl, wt, tt)
        S = np.interp(c + dl, ws, ss)
        print(f"{key}: lambda_0 {c:.3f} A, min T {T.min():.3f}, min S {S.min():.3f} over +/-{args.half} A")
        out_lines.append({"key": key, "rest": c, "start": -args.half, "step": args.step, "n": n,
                          "T": b64_u16(T), "S": b64_u16(S)})

    meta = {
        "generator": "build_obs_atlas.py",
        "created": datetime.date.today().isoformat(),
        "encoding": "little-endian uint16, value/65535; lambda_air = rest + start + step*i [A]",
        "rest_wavelengths": "Fe XIII rest air wavelengths used for DKIST/Cryo-NIRSP data: 1074.65 and 1079.80 nm",
        "telluric": {"file": TELLURIC_TRANS, "model": "US standard, CO2 416 ppm, observer altitude 3 km, PWV 3 mm, airmass 1",
                     "reference": "T. Schad, DKIST telluric atlas, https://github.com/tschad/dkist_telluric_atlas, doi:10.5281/zenodo.13922153 (v20260407, HITRAN2024, Py4CAtS)"},
        "solar": {"file": SOLAR, "model": "Toon solar pseudo-transmittance spectrum, version 2020-07-20, disk-integrated",
                  "reference": "G. C. Toon, https://mark4sun.jpl.nasa.gov/toon/solar/solar_spectrum.html"},
    }
    thomson = thomson_tables([c for _, c in lines])
    with open(args.out, "w") as f:
        f.write("/* Telluric and solar atlas cuts around Fe XIII 10747/10798 A for the Stokes Explorer.\n"
                f"   Generated by build_obs_atlas.py on {meta['created']}. Do not edit by hand. */\n")
        f.write("globalThis.FE13_OBS_ATLAS = ")
        json.dump({"meta": meta, "lines": out_lines, "thomson": thomson}, f, separators=(",", ":"))
        f.write(";\n")
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
