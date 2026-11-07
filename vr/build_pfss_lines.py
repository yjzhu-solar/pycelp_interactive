#!/usr/bin/env python
"""Trace PFSS coronal field lines for the VR page and write them to pfss_lines.js.

The potential field is solved with sunkit-magex from an SDO/HMI daily synoptic frame: NaNs set to zero,
Gaussian-smoothed, rebinned to 720 x 360, source surface at 3 solar radii, 70 radial grid points. Lines are
traced from a regular grid of seeds on the solar surface, then a subset is chosen:

  closed  spread evenly over the Sun within bands of apex height, so that large helmet loops and smaller
          active-region loops both appear; loops lower than MIN_APEX are too small to see at room scale
  open    spread evenly over where they cross the source surface

Coordinates are written in the frame of stokes_model.js, in solar radii: +x towards the sub-Earth meridian,
+y solar west, +z solar north. They are Heliographic Stonyhurst at the map time, so a model (lat, lon) is a
Stonyhurst (lat, lon). The VR page, like the explorer, puts the observer in the solar equatorial plane: Earth's
actual heliographic latitude (B0 = -6.1 deg on this date) is left out. check_frame() confirms that adding it back
reproduces sunpy's Earth-view Heliocentric frame.

Needs sunpy and sunkit-magex.

    python build_pfss_lines.py /path/to/hmi.Mrdailysynframe_720s.20240408_120000_TAI.data.fits
"""
import argparse
import base64
import datetime
import json
import warnings

import astropy
import astropy.constants as const
import astropy.units as u
import numpy as np
import sunkit_magex
import sunpy
import sunpy.map
from astropy.convolution import Gaussian2DKernel, convolve
from astropy.coordinates import SkyCoord
from astropy.io import fits
from sunkit_magex import pfss as pfsspy
from sunpy.coordinates import Heliocentric, HeliographicStonyhurst, get_earth, sun

COORD_SCALE = 1e-4          # solar radii per stored integer; int16 then reaches +/- 3.27
SPACING = 0.04              # target distance between stored points along a line, solar radii
MIN_POINTS = 6
MIN_APEX = 0.05             # solar radii above the surface
CLOSED_BANDS = [            # (lowest apex, highest apex, number of lines)
    (0.05, 0.15, 30),
    (0.15, 0.40, 40),
    (0.40, 1.00, 40),
    (1.00, 2.01, 30),
]
N_OPEN = 45


def read_magnetogram(path, shape=(720, 360)):
    """HMI daily synoptic frame as a sunpy map, smoothed and rebinned to shape (nlon, nlat)."""
    data = np.nan_to_num(fits.getdata(path, ext=0), nan=0.0)
    hdr = fits.getheader(path, ext=0)
    hdr["CUNIT2"] = "Sine Latitude"
    hdr["T_OBS"] = hdr["T_OBS"][:-8] + "_TAI"
    # CDELT1 is negative in these frames: the reference pixel sits 120 deg from the central meridian
    hdr["CRVAL1"] = 120 + sun.L0(time=hdr["T_OBS"]).to_value(u.deg)
    nx, ny = int(data.shape[1] / shape[0]), int(data.shape[0] / shape[1])
    smooth = convolve(data, Gaussian2DKernel(x_stddev=nx, y_stddev=ny), boundary="extend")
    return sunpy.map.sources.HMISynopticMap(smooth, hdr).superpixel([nx, ny] * u.pix, func=np.nanmean), hdr


def model_xyz(coords, frame):
    """SkyCoord -> model coordinates (x towards Earth's meridian, y west, z north) in solar radii."""
    h = coords.transform_to(frame)
    r = h.radius.to_value(const.R_sun)
    la, lo = h.lat.rad, h.lon.rad
    return np.c_[r * np.cos(la) * np.cos(lo), r * np.cos(la) * np.sin(lo), r * np.sin(la)]


def check_frame(coords, xyz, obstime):
    """Largest difference (solar radii) between our axes, tilted by Earth's B0, and sunpy's Earth-view Heliocentric
    frame. Returns (difference, B0 in degrees)."""
    observer = get_earth(obstime)
    b0_deg = observer.lat.to_value(u.deg)
    c = coords.transform_to(Heliocentric(observer=observer, obstime=obstime)).cartesian
    hcc = np.c_[c.z.to_value(const.R_sun), c.x.to_value(const.R_sun), c.y.to_value(const.R_sun)]
    b = np.radians(b0_deg)
    tilted = np.c_[xyz[:, 0] * np.cos(b) + xyz[:, 2] * np.sin(b), xyz[:, 1], -xyz[:, 0] * np.sin(b) + xyz[:, 2] * np.cos(b)]
    return float(np.abs(hcc - tilted).max()), float(b0_deg)


def resample(xyz):
    """Points at uniform spacing along a polyline, keeping both ends."""
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xyz, axis=0), axis=1))]
    n = max(MIN_POINTS, int(round(s[-1] / SPACING)) + 1)
    t = np.linspace(0, s[-1], n)
    return np.c_[[np.interp(t, s, xyz[:, k]) for k in range(3)]].T


def spread(points, k):
    """Indices of k unit vectors chosen greedily to stay far apart; deterministic."""
    if len(points) <= k:
        return np.arange(len(points))
    chosen = [int(np.argmax(points[:, 2]))]
    closest = points @ points[chosen[0]]
    while len(chosen) < k:
        i = int(np.argmin(closest))
        chosen.append(i)
        closest = np.maximum(closest, points @ points[i])
    return np.array(chosen)


def unit(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("magnetogram", help="HMI daily synoptic frame (hmi.Mrdailysynframe_720s) FITS file")
    ap.add_argument("--rss", type=float, default=3.0, help="source surface radius [solar radii]")
    ap.add_argument("--nr", type=int, default=70, help="radial grid points")
    ap.add_argument("--nseeds", type=int, default=60, help="seed latitudes; twice as many longitudes")
    ap.add_argument("--out", default="pfss_lines.js")
    args = ap.parse_args()
    warnings.filterwarnings("ignore")

    hmi, hdr = read_magnetogram(args.magnetogram)
    output = pfsspy.pfss(pfsspy.Input(hmi, args.nr, args.rss))
    frame = output.coordinate_frame
    hgs = HeliographicStonyhurst(obstime=frame.obstime)

    lon1 = np.linspace(0, 2 * np.pi, 2 * args.nseeds, endpoint=False)
    lat1 = np.arcsin(np.linspace(-1, 1, args.nseeds + 3)[1:-1])
    lon, lat = np.meshgrid(lon1, lat1, indexing="ij")
    seeds = SkyCoord(lon.ravel() * u.rad, lat.ravel() * u.rad, const.R_sun, frame=frame)
    traced = pfsspy.tracing.PerformanceTracer().trace(seeds, output)

    lines, is_open, sample = [], [], None
    for f in traced:
        c = f.coords
        if len(c) < 3:
            continue
        lines.append(model_xyz(c, hgs))
        is_open.append(bool(f.is_open))
        if sample is None and is_open[-1]:
            sample = (c, lines[-1])
    is_open = np.array(is_open)
    radius = [np.linalg.norm(p, axis=1) for p in lines]
    print(f"traced {len(traced)} seeds: {len(lines)} lines, {is_open.sum()} open")

    residual, b0 = check_frame(sample[0], sample[1], frame.obstime)
    print(f"frame check against Earth-view Heliocentric, B0 = {b0:.2f} deg: max difference {residual:.1e} solar radii")
    if residual > 1e-5:
        raise SystemExit("model axes do not match sunpy's Heliocentric frame")

    apex_height = np.array([r.max() - 1 for r in radius])
    apex_dir = unit(np.array([p[int(np.argmax(r))] for p, r in zip(lines, radius)]))

    closed_index = []
    for lo, hi, k in CLOSED_BANDS:
        band = np.flatnonzero(~is_open & (apex_height >= lo) & (apex_height < hi))
        closed_index.extend(band[spread(apex_dir[band], k)])
        print(f"closed, apex {lo:.2f}-{hi:.2f} solar radii: {min(k, len(band))} of {len(band)}")
    pool = np.flatnonzero(is_open)
    open_index = pool[spread(apex_dir[pool], N_OPEN)]
    print(f"open: {len(open_index)} of {len(pool)}")

    closed = [resample(lines[i]) for i in closed_index]
    opened = [resample(lines[i]) for i in open_index]
    final = closed + opened
    counts = [len(p) for p in final]
    print(f"stored {len(final)} lines, {sum(counts)} points")

    # where the scene's two labels sit: a tall loop and an open line, both near the eastern limb, clear of the
    # blob's default place at the western limb
    def label_at(p):
        r = np.linalg.norm(p, axis=1)
        return p[int(np.argmax(r))]
    def east_score(p):
        q = unit(label_at(p))
        return -q[1] - abs(q[0])
    tall = [p for i, p in zip(closed_index, closed) if apex_height[i] >= 0.6]
    label_closed = label_at(max(tall, key=east_score))
    label_open = label_at(max(opened, key=east_score))

    stacked = np.concatenate(final)
    ints = np.round(stacked / COORD_SCALE).astype("<i2")
    if np.abs(stacked).max() / COORD_SCALE >= 32767:
        raise SystemExit("coordinates overflow int16")
    data = {
        "meta": {
            "generator": "build_pfss_lines.py",
            "created": datetime.date.today().isoformat(),
            "magnetogram": hdr.get("T_REC", ""),
            "series": "hmi.Mrdailysynframe_720s",
            "obstime": frame.obstime.isot,
            "rss": args.rss,
            "nr": args.nr,
            "map_shape": [360, 720],
            "b0_neglected_deg": round(b0, 3),
            "frame": "x towards the sub-Earth meridian, y solar west, z solar north; solar radii; Heliographic Stonyhurst at obstime",
            "versions": {"sunkit_magex": sunkit_magex.__version__, "sunpy": sunpy.__version__, "astropy": astropy.__version__},
        },
        "coordScale": COORD_SCALE,
        "nClosed": len(closed),
        "counts": counts,
        "labels": {"closed": np.round(label_closed, 3).tolist(), "open": np.round(label_open, 3).tolist()},
        "xyz": base64.b64encode(ints.tobytes()).decode("ascii"),
    }
    header = ("/* PFSS coronal field lines for the VR page. Generated by build_pfss_lines.py on "
              f"{data['meta']['created']}. Do not edit by hand. */\n")
    with open(args.out, "w") as fh:
        fh.write(header + "globalThis.FE13_PFSS_LINES = " + json.dumps(data, separators=(",", ":"), ensure_ascii=False) + ";\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
