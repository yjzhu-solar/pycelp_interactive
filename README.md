# Fe XIII Stokes Explorer

An interactive forward model of the polarized emission of the coronal Fe XIII 1074.6 nm and 1079.8 nm lines from a
single plasma voxel. Move the voxel above the Sun, orient its magnetic field, and watch Stokes I, Q, U and V respond.

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
| `fe13_see_table.js` | Pre-computed table: 31 densities × 40 heights × 11 values of cos²θ_B, 749-level Fe XIII, T_e = 2.0 MK |
| `build_see_table.py` | Regenerates the table with pyCELP |

The page opens directly from disk as well; it needs an internet connection only for the fonts and three.js.

## Rebuilding the table

```bash
export XUVTOP=/path/to/chianti/dbase      # CHIANTI database
python build_see_table.py                 # all levels, ~40 min on 10 cores
python build_see_table.py --nlevels 100 --out fe13_see_table_100.js   # ~30 s
```

After regenerating the table or editing `stokes_model.js`, bump the `?v=` number on both `<script src>` tags in
`index.html`. GitHub Pages lets browsers cache these files for 10 minutes, and the version number makes a refreshed page
fetch matching copies.

The script checks the interpolation against direct pyCELP solutions at random off-grid points. The current table
interpolates C to within 0.2% and the alignment to within 4×10⁻⁴.

## Conventions

+x points to the observer, +z is solar north and +y is solar west. Q and U are measured with +Q along the chosen
reference (radial or solar north), with angles counter-clockwise as seen by the observer. pyCELP's `eps_Q'` is
I(⊥B⊥) − I(∥B⊥), so its +Q at zero azimuth is perpendicular to the projected field. The page therefore passes
`azimuthBLOSdeg = 90° − ψ_B`, where ψ_B is the counter-clockwise angle from the reference to the projected field.

## Credits

- pyCELP by T. Schad: Schad & Dima (2020), *Solar Physics* 295, 98, https://doi.org/10.1007/s11207-020-01669-1.
  `stokes_model.js` is derived from pyCELP code and is redistributed under its BSD 3-clause licence; see
  [`LICENSE-pycelp.txt`](LICENSE-pycelp.txt).
- Atomic data: CHIANTI 11.0.2 (Dere et al. 1997; Dufresne et al. 2024).
- 3D rendering: three.js, loaded from jsDelivr.
