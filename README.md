# Fe XIII Stokes Explorer

An interactive forward model of the polarized emission of the coronal Fe XIII 1074.7 nm and 1079.8 nm lines from a
single point, with no line-of-sight integration. Place a parcel of coronal plasma above the Sun, orient its magnetic field, and watch Stokes I, Q, U and V respond.

The page models one point, not a line of sight, which is the same single-point picture behind inversions such as CLEDB.
Real observations sum the emission of every point along the line of sight, weighted by its emissivity. That mixes
densities, temperatures and field directions:
- linear polarization from differently oriented fields partly cancels;
- V averages B_LOS;
- the 1079/1074 ratio leans toward the densest plasma;
- the K corona collects every electron.

These effects are often not negligible.

**Live page:** https://yjzhu-solar.github.io/pycelp_interactive/

## How it works

[pyCELP](https://github.com/tschad/pycelp) solves the atomic statistical equilibrium. For each line, the emission needs
only two numbers from it: the upper-level population term `C` and the alignment `sigma`. These depend on electron
density, temperature, height and the field inclination from the local vertical, and on that inclination only through
cos²θ_B. `build_see_table.py` tabulates them once, and the browser applies everything else analytically: field strength,
line-of-sight geometry, the Q/U reference and the line profiles.

| File | Contents |
|---|---|
| `index.html` | The page: 3D view (three.js), controls, Stokes plots |
| `stokes_model.js` | Port of `pycelp.emissionLine.calc_PolEmissCoeff` / `calc_stokesSpec` plus the voxel geometry |
| `fe13_see_table.js` | Pre-computed table: 31 densities × 40 heights × 11 values of cos²θ_B, 749-level Fe XIII, T_e = 10^6.22 K ≈ 1.66 MK (the peak of the Fe XIII contribution function) |
| `build_see_table.py` | Regenerates the table with pyCELP |
| `observe.js` | Optional observation effects: scattered photospheric light, telluric absorption, crosstalk, spectral resolution |
| `obs_atlas.js` | Telluric transmission and solar spectrum within ±25 Å of each line, sampled at 0.01 Å, plus pyCELP's J00 and ω versus height for the K corona (59 kB) |
| `build_obs_atlas.py` | Regenerates `obs_atlas.js` from the full atlases |
| `vr/` | "The Sun's hidden magnetism", the virtual-reality version for the public; see below |

The page opens directly from disk as well; it needs an internet connection only for the fonts and three.js.

## Rebuilding the table

```bash
export XUVTOP=/path/to/chianti/dbase      # CHIANTI database
python build_see_table.py --log-te 6.22   # all levels, ~50 min on 10 cores
python build_see_table.py --nlevels 100 --out fe13_see_table_100.js   # ~30 s
```

After regenerating a data file or editing a script, bump the `?v=` number on all four `<script src>` tags in
`index.html`, and on the matching tags in `vr/index.html`. GitHub Pages lets browsers cache these files for 10 minutes, and the version number makes a refreshed page
fetch matching copies.

The script checks the interpolation against direct pyCELP solutions at random off-grid points. The current table
interpolates C to within 0.2% and the alignment to within 4×10⁻⁴.

## Observation effects

The "Observation effects" card, off by default, turns the coronal profiles into a schematic observed spectrum. The
"Window" toggle widens the plots from the line to ±20 Å, about the full DKIST/Cryo-NIRSP spectral window. The effects
apply in the order light meets them:

0. **K corona**: Thomson scattering by the electrons at the same point, as in pyCELP's `Example_PSI_model_synthesis` notebook. It uses
   J00 and ω from `pycelp.allenSolRad`, tabulated in `obs_atlas.js`. It is a flat continuum, polarized tangentially, with
   a scale slider for line-of-sight effects.
1. **Scattered photospheric light** (sky aureole and instrument): the disk-integrated solar spectrum, with its continuum
   at a chosen multiple of the coronal 1074.7 nm I peak. It carries weak-field Zeeman V and Q/U from one effective
   photospheric field.
2. **Telluric absorption**: T(λ)^scale on all four Stokes parameters.
3. **Polarimetric crosstalk**: I→Q, I→U, I→V, V→Q, V→U, Q→V and U→V in a fixed solar-north frame.
4. **Spectrograph resolution**: a Gaussian line-spread function of FWHM λ/R.

This follows the DKIST/Cryo-NIRSP spectral model of T. Schad (Schad et al. 2024, *Science Advances* 10, eadq1604).
Starting values are rounded from a fit to Cryo-NIRSP 1074.7 nm data. The atlases sit relative to the Cryo-NIRSP rest air
wavelengths, 1074.65 and 1079.80 nm, rather than CHIANTI's 1074.615 and 1079.780 nm. The model leaves out noise, the
F corona, atlas velocity shifts, and per-line scattered-light amplitudes.

```bash
python build_obs_atlas.py --atlas-dir /path/to/Cryo_Line_Artifact/atlas
```

## Virtual-reality version for the public

`vr/` turns the same model into "The Sun's hidden magnetism", a WebXR experience for public outreach. It runs in the
Meta Quest Browser (Quest 2, 3 and 3S) and also works with a mouse on a computer. Visitors grab a glowing blob of
coronal plasma to move it around a 0.6 m Sun, grab the tip of its magnetic field to turn it, and watch the light respond.
A guide panel suggests four experiments: the 90° flip at the Van Vleck ("magic") angle, a field pointing at Earth,
zero field, and lower density.

- **Wording** is for a general audience. The spectra panel shows brightness (Stokes I), linear polarization
  (√(Q² + U²)) and circular polarization (Stokes V), all relative to the 1074.7 nm I peak. The direction of the linear
  polarization appears as bars at the blob and in a "telescope view" of the plane of the sky.
- **Physics** is `stokes_model.js` with `fe13_see_table.js`, unchanged. Observation effects are not included.
- **Polarization bars** have a half-length of 0.6 R☉ × √(min(1, (L/I) / 5%)), longer than the explorer's, so the
  direction reads at room scale.
- **Input**: controller triggers or hand-tracking pinches grab the blob, the field tip, sliders, buttons and panel title
  bars. Grabbing empty space (or the grip button) moves the Sun; two hands resize and turn it.

| File | Contents |
|---|---|
| `vr/index.html` | Landing page and "Enter VR" button |
| `vr/app.js` | three.js scene, WebXR session, controller/hand/mouse interaction |
| `vr/panels.js` | The guide, controls, spectra and telescope-view panels, drawn on canvases |
| `vr/vr_geom.js` | Geometry helpers shared by the scene and the panels |

WebXR needs a secure page: an `https://` address, or `localhost`. To try changes on a headset before deploying, enable
developer mode on the Quest, connect it by USB and run

```bash
python -m http.server 8000          # in this folder
adb reverse tcp:8000 tcp:8000
```

then open http://localhost:8000/vr/ in the Quest Browser.

## Conventions

+x points to the observer, +z is solar north and +y is solar west. Q and U are measured with +Q along the chosen
reference (radial or solar north), with angles counter-clockwise as seen by the observer. pyCELP's `eps_Q'` is
I(⊥B⊥) − I(∥B⊥), so its +Q at zero azimuth is perpendicular to the projected field. The page therefore passes
`azimuthBLOSdeg = 90° − ψ_B`, where ψ_B is the counter-clockwise angle from the reference to the projected field.

pyCELP assumes the saturated Hanle regime, valid for these lines above ~10⁻⁵ G. The alignment is quantized along B, so
I, Q and U depend on the field direction but not on |B|, which enters only V. At |B| = 0 there is no direction to align
to, so the page uses the unmagnetized limit instead. The atoms align along the local vertical, the symmetry axis of the
photospheric radiation. This equals pyCELP's result for a radial field, with V = 0, and the inclination and azimuth
then have no effect. The unsaturated Hanle regime between 0 and ~10⁻⁵ G is not modelled.

## Credits

- pyCELP by T. Schad: Schad & Dima (2020), *Solar Physics* 295, 98, https://doi.org/10.1007/s11207-020-01669-1.
  `stokes_model.js` is derived from pyCELP code and is redistributed under its BSD 3-clause licence; see
  [`LICENSE-pycelp.txt`](LICENSE-pycelp.txt).
- Atomic data: CHIANTI 11.0.2 (Dere et al. 1997; Dufresne et al. 2024).
- Observation-effects model: T. Schad's Cryo-NIRSP spectral model, Schad et al. (2024), *Science Advances* 10, eadq1604,
  https://doi.org/10.1126/sciadv.adq1604.
- Telluric transmission: T. Schad, DKIST telluric atlas, https://github.com/tschad/dkist_telluric_atlas,
  https://doi.org/10.5281/zenodo.13922153 (files v20260407, HITRAN2024 line list; BSD 3-clause, see
  [`LICENSE-dkist_telluric_atlas.txt`](LICENSE-dkist_telluric_atlas.txt)). It was computed with Py4CAtS
  (Schreier et al. 2019, *Atmosphere* 10, 262) from HITRAN line parameters (https://hitran.org).
- Solar pseudo-transmittance spectrum (version 2020-07-20, disk-integrated): G. C. Toon, JPL,
  https://mark4sun.jpl.nasa.gov/toon/solar/solar_spectrum.html.
- 3D rendering: three.js, loaded from jsDelivr.

## Acknowledgement

The observation-effects starting values come from DKIST/Cryo-NIRSP observations, and the telluric atlas was made for
DKIST. The Daniel K. Inouye Solar Telescope (DKIST) is a facility of the U.S. National Science Foundation. DKIST is operated by the National Solar Observatory under a cooperative agreement with the Association of Universities for Research in Astronomy, Inc. DKIST is located on land of spiritual and cultural significance to Native Hawaiian people. The use of this important site to further scientific knowledge is done with appreciation and respect.
