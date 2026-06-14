/**
 * TrollFish — config.js
 * Application constants ported from Python config.py + models.py
 */

export const SKELETON_TARGET_FPS = 10.0;
export const SKELETON_LOWER_PLANE_Z = 0.0;
export const SKELETON_HIP_PLANE_Z = 0.06;
export const MAP_MAX_POINTS_PER_TRACK = 2500;
export const MATCH_SAMPLE_POINTS = 320;

export const APP_ASSET_VERSION = '20260524boom5';
export const BOOM_MODEL_VERSION = '20260524-centered-boom1';

/** Maximum plausible GPS speed in m/s (~50 knots, used for outlier filter) */
export const MAX_PLAUSIBLE_SPEED_MS = 25.0;

/** Default camera parameters from ProjectCvConfig */
export const DEFAULT_CV_CONFIG = Object.freeze({
  pose_model: 'full',
  camera_position: [-3.194, 0.02, 0.585],
  camera_pitch_deg: 14.7,
  camera_yaw_deg: 0.0,
  camera_roll_deg: 0.0,
  camera_R_wc: null,
  lower_plane_z: -0.01,
  hip_plane_z: 0.04,
  lower_landmark: 'ankle',
  athlete_weight: 75.0,
  athlete_height: null,
  boat_com: -1.114,
  mediapipe_workers: null,
  skeleton_filter: {},
  contact_params: {},
  seated_x_stabilizer: {},
  lateral_y_stabilizer: {},
  hiking_placement: {
    enabled: true,
    knee_plane_z: 0.09,
    knee_weight: 2.0,
    hip_weight: 0.5,
    ankle_weight: 1.0,
    hip_outside_abs_y: 0.66,
    x_stability_enabled: true,
    x_stability_sigma_m: 0.12,
    x_stability_min_scale: 0.2,
    x_stability_alpha: 0.15,
    x_stability_position_blend: 0.65,
    x_stability_max_step_m: 0.04,
    x_stability_reacquire_threshold_m: 0.28,
    x_stability_reacquire_frames: 5,
    x_stability_reacquire_agreement_m: 0.22,
    x_stability_reacquire_alpha: 0.7,
    height_normalization_enabled: true,
    height_scale_alpha: 0.12,
    height_scale_min: 0.75,
    height_scale_max: 1.35,
  },
  auto_camera_pnp: {
    enabled: true,
    interval_frames: 10000,
    avg_frames: 5,
    min_valid_frames: 5,
  },
  // Manual tuning offset applied ON TOP of the (possibly Auto-PnP) camera pose,
  // set from the Hull 3D tuning panel. Angles in degrees (camera-relative),
  // positions/plane heights in metres. All zero = no override.
  camera_pose_offset: {
    pitch_deg: 0.0,
    yaw_deg: 0.0,
    roll_deg: 0.0,
    x_m: 0.0,
    y_m: 0.0,
    z_m: 0.0,
    hip_z_m: 0.0,
    ankle_z_m: 0.0,
  },
});

/** Calibration files will be loaded lazily and cached here */
const _calibrations = {};

/**
 * Load the GoPro fisheye calibration data.
 * Returns { K: number[][], D: number[][], rms: number, img_size: number[] }
 */
export function isGoPro13Model(value) {
  const text = String(value || '').toLowerCase();
  return /\bhero\s*13\b|\bhero13\b|\bgopro\s*13\b/.test(text);
}

export async function getCalibration(variant = 'default') {
  const key = variant === 'gopro13' ? 'gopro13' : 'default';
  if (_calibrations[key]) return _calibrations[key];
  const filename = key === 'gopro13' ? '../gopro13calib.json' : '../calibration.json';
  const resp = await fetch(new URL(filename, import.meta.url));
  if (!resp.ok) throw new Error(`Failed to load ${filename.replace('../', '')}`);
  _calibrations[key] = await resp.json();
  return _calibrations[key];
}

/**
 * SOG display cap (knots). Values above this are treated as outliers.
 */
export const SOG_MAX_KT = 22;

/**
 * Colour palette for tracks/athletes.
 */
export const PALETTE = Object.freeze([
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#00bcd4', '#ff6b6b', '#4ecdc4',
]);
