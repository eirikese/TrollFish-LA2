/**
 * TrollFish — rayplane.js
 * Ray-plane intersection & skeleton placement — port from Python rayplane.py
 *
 * Coordinate system:
 *   World/Boat frame: X = fore-aft (negative = forward/bow),
 *                     Y = lateral (port/starboard), Z = vertical (up)
 *   Camera base orientation: cam Z → world X, cam X → world −Y, cam Y → world −Z
 */

// ── Matrix / Vector helpers (inline, no dependency on gl-matrix) ──────

/** 3×3 matrix multiply: C = A * B (row-major arrays of length 9) */
function mat3mul(A, B) {
  return [
    A[0]*B[0]+A[1]*B[3]+A[2]*B[6], A[0]*B[1]+A[1]*B[4]+A[2]*B[7], A[0]*B[2]+A[1]*B[5]+A[2]*B[8],
    A[3]*B[0]+A[4]*B[3]+A[5]*B[6], A[3]*B[1]+A[4]*B[4]+A[5]*B[7], A[3]*B[2]+A[4]*B[5]+A[5]*B[8],
    A[6]*B[0]+A[7]*B[3]+A[8]*B[6], A[6]*B[1]+A[7]*B[4]+A[8]*B[7], A[6]*B[2]+A[7]*B[5]+A[8]*B[8],
  ];
}

/** 3×3 transpose */
function mat3T(M) {
  return [M[0],M[3],M[6], M[1],M[4],M[7], M[2],M[5],M[8]];
}

/** 3×3 * vec3 */
function mat3vec(M, v) {
  return [
    M[0]*v[0]+M[1]*v[1]+M[2]*v[2],
    M[3]*v[0]+M[4]*v[1]+M[5]*v[2],
    M[6]*v[0]+M[7]*v[1]+M[8]*v[2],
  ];
}

function vec3add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function vec3sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vec3scale(v, s) { return [v[0]*s, v[1]*s, v[2]*s]; }
function vec3dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function vec3cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function vec3len(v) { return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }
function vec3norm(v) { const l=vec3len(v); return l<1e-12?[0,0,0]:[v[0]/l,v[1]/l,v[2]/l]; }
function isFinitePoint3(p) {
  return Array.isArray(p) && p.length >= 3
    && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
}

// ── Rotation matrices ─────────────────────────────────────────────────

function rotX(deg) {
  const r=deg*Math.PI/180, c=Math.cos(r), s=Math.sin(r);
  return [1,0,0, 0,c,-s, 0,s,c];
}
function rotY(deg) {
  const r=deg*Math.PI/180, c=Math.cos(r), s=Math.sin(r);
  return [c,0,s, 0,1,0, -s,0,c];
}
function rotZ(deg) {
  const r=deg*Math.PI/180, c=Math.cos(r), s=Math.sin(r);
  return [c,-s,0, s,c,0, 0,0,1];
}

// ── Camera pose ───────────────────────────────────────────────────────

// Base rotation: camera Z→world X, camera X→world −Y, camera Y→world −Z
const BASE_ROT = [0,0,1, -1,0,0, 0,-1,0];

/**
 * Default camera pose and rotation matrix (camera-to-world).
 * @returns {{pos: number[3], R_wc: number[9]}}
 */
export function defaultCameraPoseAndRotation(pitch = 14.7, yaw = 0.0, roll = 0.0) {
  const pos = [-3.194, 0.02, 0.585];
  // Relative rotation: Rz(roll) @ Ry(yaw) @ Rx(-pitch)
  const R_rel = mat3mul(rotZ(roll), mat3mul(rotY(yaw), rotX(-pitch)));
  const R_wc = mat3mul(BASE_ROT, R_rel);
  return { pos, R_wc };
}

/**
 * Apply a manual tuning offset on top of an existing (e.g. Auto-PnP-estimated)
 * camera pose. The angle offsets are applied in the camera's own relative frame
 * — i.e. R_wc_new = R_wc @ Rz(dRoll) @ Ry(dYaw) @ Rx(-dPitch) — matching the
 * convention in defaultCameraPoseAndRotation(). Position offsets add directly to
 * the camera world position. Returns NEW arrays; inputs are not mutated.
 *
 * @param {number[9]} R_wc — current camera-to-world rotation (row-major 3×3)
 * @param {number[3]} camPos — current camera world position
 * @param {object} offset — { pitch_deg, yaw_deg, roll_deg, x_m, y_m, z_m }
 * @returns {{R_wc:number[9], camPos:number[3]}}
 */
export function applyCameraPoseOffset(R_wc, camPos, offset = {}) {
  const dPitch = Number(offset.pitch_deg) || 0;
  const dYaw   = Number(offset.yaw_deg) || 0;
  const dRoll  = Number(offset.roll_deg) || 0;
  const dx = Number(offset.x_m) || 0;
  const dy = Number(offset.y_m) || 0;
  const dz = Number(offset.z_m) || 0;

  let Rout = R_wc;
  if (dPitch || dYaw || dRoll) {
    const R_rel = mat3mul(rotZ(dRoll), mat3mul(rotY(dYaw), rotX(-dPitch)));
    Rout = mat3mul(R_wc, R_rel);
  }
  return {
    R_wc: Rout,
    camPos: [camPos[0] + dx, camPos[1] + dy, camPos[2] + dz],
  };
}

/** True if a camera_pose_offset object has any non-zero component. */
export function cameraPoseOffsetIsActive(offset) {
  if (!offset || typeof offset !== 'object') return false;
  return ['pitch_deg', 'yaw_deg', 'roll_deg', 'x_m', 'y_m', 'z_m', 'hip_z_m', 'ankle_z_m']
    .some(k => Number(offset[k]) || 0);
}

// ── Ray construction ──────────────────────────────────────────────────

/**
 * Convert MediaPipe normalized [0,1] coords to a unit ray in camera frame.
 * Uses the undistorted intrinsic matrix K.
 * @param {number} xNorm — normalized x [0,1]
 * @param {number} yNorm — normalized y [0,1]
 * @param {number} W — image width
 * @param {number} H — image height
 * @param {number[]} K — 3×3 intrinsic matrix (row-major, 9 elements)
 * @returns {number[3]} unit ray in camera frame
 */
export function rayFromNormLandmark(xNorm, yNorm, W, H, K) {
  const u = xNorm * W;
  const v = yNorm * H;
  const fx = K[0], fy = K[4], cx = K[2], cy = K[5];
  const xn = (u - cx) / fx;
  const yn = (v - cy) / fy;
  return vec3norm([xn, yn, 1.0]);
}

/**
 * Intersect a camera-frame ray with a world-space z = Z0 plane.
 * @param {number[3]} d_c — ray direction in camera frame
 * @param {number[9]} R_wc — camera-to-world rotation (row-major 3×3)
 * @param {number[3]} t_wc — camera position in world
 * @param {number} Z0 — plane height
 * @returns {number[3]|null} world intersection point
 */
export function intersectWorldZPlane(d_c, R_wc, t_wc, Z0, eps = 1e-9) {
  const d_w = mat3vec(R_wc, d_c);
  const dz = d_w[2];
  if (Math.abs(dz) < eps) return null; // parallel
  const t = (Z0 - t_wc[2]) / dz;
  if (t < 0) return null; // behind camera
  return vec3add(t_wc, vec3scale(d_w, t));
}

// ── Rotation alignment ────────────────────────────────────────────────

/**
 * Rodrigues rotation matrix mapping unit vector a → b.
 */
function rotationFromAToB(a, b) {
  const d = vec3dot(a, b);
  if (d > 0.9999) return [1,0,0,0,1,0,0,0,1]; // identity
  if (d < -0.9999) {
    // anti-parallel: rotate 180° about any perpendicular axis
    let perp = Math.abs(a[0]) < 0.9 ? vec3cross(a, [1,0,0]) : vec3cross(a, [0,1,0]);
    perp = vec3norm(perp);
    // 180° rotation about perp: R = 2*p*pT - I
    return [
      2*perp[0]*perp[0]-1, 2*perp[0]*perp[1],   2*perp[0]*perp[2],
      2*perp[1]*perp[0],   2*perp[1]*perp[1]-1,  2*perp[1]*perp[2],
      2*perp[2]*perp[0],   2*perp[2]*perp[1],    2*perp[2]*perp[2]-1,
    ];
  }
  const v = vec3cross(a, b);
  const s = vec3len(v);
  const c = d;
  // skew-symmetric matrix of v
  const vx = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
  // vx² = v⊗v - s²I → (1-c)/s² factor
  const f = (1 - c) / (s * s);
  const vx2 = mat3mul(vx, vx);
  return [
    1 + vx[0] + vx2[0]*f, vx[1] + vx2[1]*f,     vx[2] + vx2[2]*f,
    vx[3] + vx2[3]*f,     1 + vx[4] + vx2[4]*f,  vx[5] + vx2[5]*f,
    vx[6] + vx2[6]*f,     vx[7] + vx2[7]*f,      1 + vx[8] + vx2[8]*f,
  ];
}

/**
 * Two-vector rotation: align primary a1→b1 and secondary a2→b2.
 */
function rotationFromTwoVectors(a1, a2, b1, b2) {
  // Gram-Schmidt: orthonormalize secondary w.r.t. primary
  const a1n = vec3norm(a1);
  const b1n = vec3norm(b1);
  let a2orth = vec3sub(a2, vec3scale(a1n, vec3dot(a2, a1n)));
  let b2orth = vec3sub(b2, vec3scale(b1n, vec3dot(b2, b1n)));
  const la2 = vec3len(a2orth), lb2 = vec3len(b2orth);
  if (la2 < 1e-9 || lb2 < 1e-9) return rotationFromAToB(a1n, b1n);
  a2orth = vec3scale(a2orth, 1/la2);
  b2orth = vec3scale(b2orth, 1/lb2);
  const a3 = vec3cross(a1n, a2orth);
  const b3 = vec3cross(b1n, b2orth);
  // Source basis S = [a1n|a2orth|a3] cols, Target B = [b1n|b2orth|b3] cols
  // R = B * S^T (row-major)
  const S = [a1n[0],a2orth[0],a3[0], a1n[1],a2orth[1],a3[1], a1n[2],a2orth[2],a3[2]];
  const B = [b1n[0],b2orth[0],b3[0], b1n[1],b2orth[1],b3[1], b1n[2],b2orth[2],b3[2]];
  return mat3mul(B, mat3T(S));
}

// ── Skeleton placement ────────────────────────────────────────────────

const DEFAULT_HIKING_PLACEMENT = Object.freeze({
  enabled: true,
  kneePlaneZ: 0.05,
  normalHipWeight: 2.0,
  normalAnkleWeight: 1.0,
  hikingKneeWeight: 8.0,
  hikingHipWeight: 0.4,
  hikingAnkleWeight: 0.25,
  hipOutsideAbsY: 0.6,
  xStabilityEnabled: true,
  xStabilitySigmaM: 0.18,
  xStabilityMinScale: 0.2,
  xStabilityAlpha: 0.25,
  xStabilityPositionBlend: 0.65,
  xStabilityMaxStepM: 0.04,
  xStabilityReacquireThresholdM: 0.28,
  xStabilityReacquireFrames: 3,
  xStabilityReacquireAgreementM: 0.22,
  xStabilityReacquireAlpha: 0.7,
  heightNormalizationEnabled: true,
  heightScaleAlpha: 0.12,
  heightScaleMin: 0.75,
  heightScaleMax: 1.35,
});

function _numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _normalizeHikingPlacementOptions(options = {}) {
  const raw = options.hikingPlacement || options.hiking_placement || {};
  return {
    enabled: raw.enabled !== false,
    kneePlaneZ: _numOr(raw.kneePlaneZ ?? raw.knee_plane_z, DEFAULT_HIKING_PLACEMENT.kneePlaneZ),
    normalHipWeight: _numOr(raw.normalHipWeight ?? raw.normal_hip_weight, DEFAULT_HIKING_PLACEMENT.normalHipWeight),
    normalAnkleWeight: _numOr(raw.normalAnkleWeight ?? raw.normal_ankle_weight, DEFAULT_HIKING_PLACEMENT.normalAnkleWeight),
    hikingKneeWeight: _numOr(raw.hikingKneeWeight ?? raw.knee_weight, DEFAULT_HIKING_PLACEMENT.hikingKneeWeight),
    hikingHipWeight: _numOr(raw.hikingHipWeight ?? raw.hip_weight, DEFAULT_HIKING_PLACEMENT.hikingHipWeight),
    hikingAnkleWeight: _numOr(raw.hikingAnkleWeight ?? raw.ankle_weight, DEFAULT_HIKING_PLACEMENT.hikingAnkleWeight),
    hipOutsideAbsY: _numOr(raw.hipOutsideAbsY ?? raw.hip_outside_abs_y, DEFAULT_HIKING_PLACEMENT.hipOutsideAbsY),
    xStabilityEnabled: raw.xStabilityEnabled ?? raw.x_stability_enabled ?? DEFAULT_HIKING_PLACEMENT.xStabilityEnabled,
    xStabilitySigmaM: _numOr(raw.xStabilitySigmaM ?? raw.x_stability_sigma_m, DEFAULT_HIKING_PLACEMENT.xStabilitySigmaM),
    xStabilityMinScale: _numOr(raw.xStabilityMinScale ?? raw.x_stability_min_scale, DEFAULT_HIKING_PLACEMENT.xStabilityMinScale),
    xStabilityAlpha: _numOr(raw.xStabilityAlpha ?? raw.x_stability_alpha, DEFAULT_HIKING_PLACEMENT.xStabilityAlpha),
    xStabilityPositionBlend: _numOr(raw.xStabilityPositionBlend ?? raw.x_stability_position_blend, DEFAULT_HIKING_PLACEMENT.xStabilityPositionBlend),
    xStabilityMaxStepM: _numOr(raw.xStabilityMaxStepM ?? raw.x_stability_max_step_m, DEFAULT_HIKING_PLACEMENT.xStabilityMaxStepM),
    xStabilityReacquireThresholdM: _numOr(raw.xStabilityReacquireThresholdM ?? raw.x_stability_reacquire_threshold_m, DEFAULT_HIKING_PLACEMENT.xStabilityReacquireThresholdM),
    xStabilityReacquireFrames: _numOr(raw.xStabilityReacquireFrames ?? raw.x_stability_reacquire_frames, DEFAULT_HIKING_PLACEMENT.xStabilityReacquireFrames),
    xStabilityReacquireAgreementM: _numOr(raw.xStabilityReacquireAgreementM ?? raw.x_stability_reacquire_agreement_m, DEFAULT_HIKING_PLACEMENT.xStabilityReacquireAgreementM),
    xStabilityReacquireAlpha: _numOr(raw.xStabilityReacquireAlpha ?? raw.x_stability_reacquire_alpha, DEFAULT_HIKING_PLACEMENT.xStabilityReacquireAlpha),
    heightNormalizationEnabled: raw.heightNormalizationEnabled ?? raw.height_normalization_enabled ?? DEFAULT_HIKING_PLACEMENT.heightNormalizationEnabled,
    heightScaleAlpha: _numOr(raw.heightScaleAlpha ?? raw.height_scale_alpha, DEFAULT_HIKING_PLACEMENT.heightScaleAlpha),
    heightScaleMin: _numOr(raw.heightScaleMin ?? raw.height_scale_min, DEFAULT_HIKING_PLACEMENT.heightScaleMin),
    heightScaleMax: _numOr(raw.heightScaleMax ?? raw.height_scale_max, DEFAULT_HIKING_PLACEMENT.heightScaleMax),
  };
}

function _avgPoint(points) {
  if (!points.length) return null;
  const sum = points.reduce((acc, p) => vec3add(acc, p), [0, 0, 0]);
  return vec3scale(sum, 1 / points.length);
}

function _dist3(a, b) {
  if (!isFinitePoint3(a) || !isFinitePoint3(b)) return null;
  return vec3len(vec3sub(a, b));
}

function _normalizeAthleteHeightM(height) {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) return null;
  const metres = h > 3 ? h / 100 : h;
  return metres >= 1.0 && metres <= 2.4 ? metres : null;
}

function _estimateWorldSkeletonHeight(worldLandmarks) {
  const midShoulder = _avgPoint([11, 12].filter(i => isFinitePoint3(worldLandmarks[i])).map(i => worldLandmarks[i]));
  const head = _avgPoint([0, 7, 8, 9, 10].filter(i => isFinitePoint3(worldLandmarks[i])).map(i => worldLandmarks[i]));
  const neckHead = _dist3(midShoulder, head);
  const headTopAllowance = neckHead != null ? neckHead * 0.35 : 0.12;

  const chains = [];
  for (const [hipIdx, kneeIdx, ankleIdx] of [[23, 25, 27], [24, 26, 28]]) {
    const hip = worldLandmarks[hipIdx];
    const knee = worldLandmarks[kneeIdx];
    const ankle = worldLandmarks[ankleIdx];
    const thigh = _dist3(hip, knee);
    const shank = _dist3(knee, ankle);
    const trunk = _dist3(hip, midShoulder);
    if (thigh != null && shank != null && trunk != null && neckHead != null) {
      chains.push(thigh + shank + trunk + neckHead + headTopAllowance);
    }
  }
  return chains.length ? chains.reduce((sum, v) => sum + v, 0) / chains.length : null;
}

function _scaleWorldLandmarksForPlacement(worldLandmarks, athleteHeight, cfg, state = null) {
  if (!cfg?.heightNormalizationEnabled) return { worldLandmarks, scale: 1, measuredHeight: null, applied: false };
  const targetHeight = _normalizeAthleteHeightM(athleteHeight);
  if (targetHeight == null) return { worldLandmarks, scale: 1, measuredHeight: null, targetHeight, applied: false };

  const measuredHeight = _estimateWorldSkeletonHeight(worldLandmarks);
  if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
    return { worldLandmarks, scale: 1, measuredHeight: measuredHeight ?? null, targetHeight, applied: false };
  }

  const minScale = Math.max(0.2, Number(cfg.heightScaleMin) || DEFAULT_HIKING_PLACEMENT.heightScaleMin);
  const maxScale = Math.max(minScale, Number(cfg.heightScaleMax) || DEFAULT_HIKING_PLACEMENT.heightScaleMax);
  const rawScale = Math.max(minScale, Math.min(maxScale, targetHeight / measuredHeight));
  const alpha = Math.max(0.01, Math.min(1, Number(cfg.heightScaleAlpha) || DEFAULT_HIKING_PLACEMENT.heightScaleAlpha));
  const scale = state
    ? (Number.isFinite(state.heightScale) ? state.heightScale + alpha * (rawScale - state.heightScale) : rawScale)
    : rawScale;
  if (state) state.heightScale = scale;
  if (Math.abs(scale - 1) < 0.005) return { worldLandmarks, scale: 1, measuredHeight, targetHeight, applied: false };

  const anchor = _avgPoint([23, 24].filter(i => isFinitePoint3(worldLandmarks[i])).map(i => worldLandmarks[i])) || [0, 0, 0];
  const scaled = {};
  for (let i = 0; i < 33; i++) {
    const p = worldLandmarks[i];
    if (!isFinitePoint3(p)) continue;
    scaled[i] = [
      anchor[0] + (p[0] - anchor[0]) * scale,
      anchor[1] + (p[1] - anchor[1]) * scale,
      anchor[2] + (p[2] - anchor[2]) * scale,
    ];
  }
  return { worldLandmarks: scaled, scale, measuredHeight, targetHeight, applied: true };
}

function _buildAnchorMeasurement(anchor, worldLandmarks, normLandmarks, K, W, H, camPos, R_wc) {
  const weight = Number(anchor.weight);
  if (!(weight > 0)) return null;

  const intersections = [];
  for (const idx of anchor.rayIndices) {
    const nrm = normLandmarks[idx];
    if (!nrm) continue;
    const ray = rayFromNormLandmark(nrm[0], nrm[1], W, H, K);
    const pt = intersectWorldZPlane(ray, R_wc, camPos, anchor.z);
    if (pt) intersections.push(pt);
  }
  if (!intersections.length) return null;

  const mpPoints = anchor.mpIndices
    .filter(i => isFinitePoint3(worldLandmarks[i]))
    .map(i => worldLandmarks[i]);
  const mpMid = _avgPoint(mpPoints);
  if (!mpMid) return null;

  const worldAvg = _avgPoint(intersections);
  const mpWorld = mat3vec(R_wc, mpMid);
  const offset = vec3sub(worldAvg, mpWorld);
  offset[2] = anchor.z - mpWorld[2];

  return {
    name: anchor.name || 'anchor',
    offset,
    baseWeight: weight,
    weight,
    xStabilityScale: 1.0,
  };
}

function _median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _span(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  return Math.max(...finite) - Math.min(...finite);
}

function _applyHikingXStability(measurements, cfg, state = null) {
  if (!cfg?.xStabilityEnabled || measurements.length < 2) {
    return { targetX: null, applied: false, stableX: Number.isFinite(state?.stableX) ? state.stableX : null };
  }

  const candidateXs = measurements.map(m => m.candidateX).filter(Number.isFinite);
  const priorX = Number.isFinite(state?.stableX) ? state.stableX : null;
  const targetX = priorX ?? _median(candidateXs);
  const sigma = Math.max(0.01, Number(cfg.xStabilitySigmaM) || DEFAULT_HIKING_PLACEMENT.xStabilitySigmaM);
  const minScale = Math.max(0, Math.min(1, Number(cfg.xStabilityMinScale) || 0));
  if (!Number.isFinite(targetX)) return { targetX: null, applied: false, stableX: null };

  for (const m of measurements) {
    const dx = Math.abs(m.candidateX - targetX);
    const gaussian = Math.exp(-0.5 * (dx / sigma) ** 2);
    const scale = minScale + (1 - minScale) * gaussian;
    m.xStabilityScale = scale;
    m.weight = m.baseWeight * scale;
  }
  return { targetX, applied: true, stableX: priorX };
}

function _buildPlacedSkeletonFromAnchors(worldLandmarks, normLandmarks, K, W, H, camPos, R_wc, anchors, fusion = null) {
  const measurements = [];
  for (const anchor of anchors) {
    const measurement = _buildAnchorMeasurement(anchor, worldLandmarks, normLandmarks, K, W, H, camPos, R_wc);
    if (measurement) measurements.push(measurement);
  }

  const hipMpMid = _avgPoint([23, 24].filter(i => isFinitePoint3(worldLandmarks[i])).map(i => worldLandmarks[i]));
  const hipWorldNoTranslation = hipMpMid ? mat3vec(R_wc, hipMpMid) : null;
  for (const m of measurements) {
    m.candidateX = (hipWorldNoTranslation ? hipWorldNoTranslation[0] : 0) + m.offset[0];
  }

  const fusionMeta = fusion?.mode === 'hiking_x_stability'
    ? _applyHikingXStability(measurements, fusion.config, fusion.state)
    : { targetX: null, applied: false };

  let translationSum = [0, 0, 0];
  let totalWeight = 0;
  for (const m of measurements) {
    translationSum = vec3add(translationSum, vec3scale(m.offset, m.weight));
    totalWeight += m.weight;
  }

  if (totalWeight < 0.01) return null;
  const translation = vec3scale(translationSum, 1 / totalWeight);
  const rawFusedX = (hipWorldNoTranslation ? hipWorldNoTranslation[0] : 0) + translation[0];
  let fusedX = rawFusedX;
  let stableX = fusionMeta.stableX ?? null;
  let xPositionCorrection = 0;
  let xReacquireActive = false;
  if (fusion?.mode === 'hiking_x_stability' && fusion?.state && fusionMeta.applied && Number.isFinite(rawFusedX)) {
    const priorX = Number.isFinite(fusion.state.stableX) ? fusion.state.stableX : null;
    const candidateSpread = _span(measurements.map(m => m.candidateX));
    const reacquireThreshold = Math.max(0.01, Number(fusion.config?.xStabilityReacquireThresholdM) || DEFAULT_HIKING_PLACEMENT.xStabilityReacquireThresholdM);
    const reacquireFrames = Math.max(1, Math.round(Number(fusion.config?.xStabilityReacquireFrames) || DEFAULT_HIKING_PLACEMENT.xStabilityReacquireFrames));
    const reacquireAgreement = Math.max(0.01, Number(fusion.config?.xStabilityReacquireAgreementM) || DEFAULT_HIKING_PLACEMENT.xStabilityReacquireAgreementM);
    if (priorX != null && Math.abs(rawFusedX - priorX) >= reacquireThreshold && candidateSpread <= reacquireAgreement) {
      fusion.state.xReacquireCount = (Number(fusion.state.xReacquireCount) || 0) + 1;
    } else {
      fusion.state.xReacquireCount = 0;
    }
    xReacquireActive = fusion.state.xReacquireCount >= reacquireFrames;

    if (priorX != null) {
      const blend = xReacquireActive ? 0 : Math.max(0, Math.min(1, Number(fusion.config?.xStabilityPositionBlend) || 0));
      let correctedX = rawFusedX + blend * (priorX - rawFusedX);
      const maxStep = Number(fusion.config?.xStabilityMaxStepM);
      if (!xReacquireActive && Number.isFinite(maxStep) && maxStep > 0) {
        correctedX = Math.max(priorX - maxStep, Math.min(priorX + maxStep, correctedX));
      }
      xPositionCorrection = correctedX - rawFusedX;
      translation[0] += xPositionCorrection;
      fusedX = correctedX;
    }
    const alpha = xReacquireActive
      ? Math.max(0.01, Math.min(1, Number(fusion.config?.xStabilityReacquireAlpha) || DEFAULT_HIKING_PLACEMENT.xStabilityReacquireAlpha))
      : Math.max(0.01, Math.min(1, Number(fusion.config?.xStabilityAlpha) || DEFAULT_HIKING_PLACEMENT.xStabilityAlpha));
    stableX = Number.isFinite(fusion.state.stableX)
      ? fusion.state.stableX + alpha * (fusedX - fusion.state.stableX)
      : fusedX;
    fusion.state.stableX = stableX;
  }

  const placed = {};
  for (let i = 0; i < 33; i++) {
    const lm = worldLandmarks[i];
    if (!lm) continue;
    placed[i] = vec3add(mat3vec(R_wc, lm), translation);
  }
  _attachPlacementMeta(placed, {
    fusionTargetX: fusionMeta.targetX,
    fusionStableX: stableX,
    fusionRawX: rawFusedX,
    fusionXCorrection: xPositionCorrection,
    fusionXReacquireActive: xReacquireActive,
    fusionXReacquireCount: Number(fusion?.state?.xReacquireCount) || 0,
    xStabilityApplied: fusionMeta.applied,
    anchorWeights: measurements.map(m => ({
      name: m.name,
      baseWeight: m.baseWeight,
      weight: m.weight,
      x: m.candidateX,
      xStabilityScale: m.xStabilityScale,
    })),
  });
  return placed;
}

function _attachPlacementMeta(placed, meta) {
  if (placed && typeof placed === 'object') {
    Object.defineProperty(placed, '__placementMeta', {
      value: Object.freeze({ ...meta }),
      enumerable: false,
      configurable: true,
    });
  }
  return placed;
}

function _detectHikingFromNormalPlacement(placed, cfg) {
  const leftHip = placed?.[23];
  const rightHip = placed?.[24];
  if (![leftHip, rightHip].every(isFinitePoint3)) return null;

  const hipMid = vec3scale(vec3add(leftHip, rightHip), 0.5);
  if (Math.abs(hipMid[1]) < cfg.hipOutsideAbsY) return null;

  return {
    hipMid,
    side: hipMid[1] >= 0 ? 1 : -1,
  };
}

/**
 * Primary placement path: symmetric raycast.
 * Preserves MediaPipe body orientation, solves global translation from
 * ray-plane constraints on hips and lower limbs.
 *
 * @param {Object} worldLandmarks — {0..32: [x,y,z]} in camera/MP world frame
 * @param {Object} normLandmarks  — {0..32: [x,y,z,vis]} normalized image coords
 * @param {number[9]} K — intrinsic matrix (row-major)
 * @param {number} W — image width
 * @param {number} H — image height
 * @param {number[3]} camPos — camera position in world
 * @param {number[9]} R_wc — camera-to-world rotation
 * @param {number} zHip — hip plane height
 * @param {number} zAnkle — ankle/foot plane height
 * @param {Object} options — optional placement tuning, including hikingPlacement
 * @returns {Object|null} {0..32: [x,y,z]} in world frame
 */
export function computePlacedSkeletonSymmetricRaycast(
  worldLandmarks, normLandmarks, K, W, H, camPos, R_wc, zHip, zAnkle, options = {}
) {
  // We need at least hips + one lower limb landmark
  const lm23w = worldLandmarks[23];
  const lm24w = worldLandmarks[24];
  if (!lm23w || !lm24w) return null;
  const hikingCfg = _normalizeHikingPlacementOptions(options);
  const normalAnchors = [
    { name: 'hip', rayIndices: [23, 24], mpIndices: [23, 24], z: zHip, weight: hikingCfg.normalHipWeight },
    { name: 'ankle', rayIndices: [27, 28, 31, 32], mpIndices: [27, 28], z: zAnkle, weight: hikingCfg.normalAnkleWeight },
  ];
  const normalPlaced = _buildPlacedSkeletonFromAnchors(
    worldLandmarks, normLandmarks, K, W, H, camPos, R_wc, normalAnchors
  );
  if (!normalPlaced) return null;

  let placed = normalPlaced;
  let placementMeta = {
    mode: 'normal',
    hikingDetected: false,
    kneePlaneZ: null,
  };

  if (hikingCfg.enabled) {
    const hikingState = _detectHikingFromNormalPlacement(normalPlaced, hikingCfg);
    if (hikingState) {
      if (options.hikingFusionState) {
        if (options.hikingFusionState.side !== hikingState.side) {
          options.hikingFusionState.stableX = null;
          options.hikingFusionState.xReacquireCount = 0;
        }
        options.hikingFusionState.side = hikingState.side;
      }
      const heightNorm = _scaleWorldLandmarksForPlacement(
        worldLandmarks,
        options.athleteHeight,
        hikingCfg,
        options.hikingFusionState || null
      );
      const placementWorldLandmarks = heightNorm.worldLandmarks;
      const hikingAnchors = [
        { name: 'hip', rayIndices: [23, 24], mpIndices: [23, 24], z: zHip, weight: hikingCfg.hikingHipWeight },
        { name: 'knee', rayIndices: [25, 26], mpIndices: [25, 26], z: hikingCfg.kneePlaneZ, weight: hikingCfg.hikingKneeWeight },
        { name: 'ankle', rayIndices: [27, 28, 31, 32], mpIndices: [27, 28], z: zAnkle, weight: hikingCfg.hikingAnkleWeight },
      ];
      const hikingPlaced = _buildPlacedSkeletonFromAnchors(
        placementWorldLandmarks, normLandmarks, K, W, H, camPos, R_wc, hikingAnchors,
        { mode: 'hiking_x_stability', config: hikingCfg, state: options.hikingFusionState || null }
      );
      if (hikingPlaced) {
        const hikingFusionMeta = hikingPlaced.__placementMeta || {};
        placed = hikingPlaced;
        placementMeta = {
          ...hikingFusionMeta,
          mode: 'hiking',
          hikingDetected: true,
          kneePlaneZ: hikingCfg.kneePlaneZ,
          heightNormalizationApplied: heightNorm.applied,
          heightNormalizationScale: heightNorm.scale,
          heightNormalizationMeasuredHeight: heightNorm.measuredHeight,
          heightNormalizationTargetHeight: heightNorm.targetHeight,
          side: hikingState.side,
        };
      }
    } else if (options.hikingFusionState) {
      options.hikingFusionState.stableX = null;
      options.hikingFusionState.side = null;
      options.hikingFusionState.xReacquireCount = 0;
    }
  }

  // Flip disambiguation: check upright (shoulders above hips, head above hips)
  const shouldersZ = _avgZ(placed, [11, 12]);
  const hipsZ = _avgZ(placed, [23, 24]);
  const headZ = _avgZ(placed, [0, 7, 8]);
  if (shouldersZ !== null && hipsZ !== null && shouldersZ < hipsZ) {
    // Upside down — try flipping 180° around world X
    // This is a rare edge case; skip for now
  }

  return _attachPlacementMeta(placed, placementMeta);
}

function _avgZ(skeleton, indices) {
  let sum = 0, cnt = 0;
  for (const i of indices) {
    if (skeleton[i]) { sum += skeleton[i][2]; cnt++; }
  }
  return cnt > 0 ? sum / cnt : null;
}

/**
 * Fallback placement: rigid body transform using anchor + direction vectors.
 */
export function placeSkeletonOnBoat(
  worldLandmarks,
  anchorIdx = 24, dirIdx = 28,
  anchorBoat = [0, 0, 0.06], dirBoat = [0, 0, 0],
  rollIdx = null, rollBoat = null
) {
  const srcAnchor = worldLandmarks[anchorIdx];
  const srcDir = worldLandmarks[dirIdx];
  if (!srcAnchor || !srcDir) return null;

  const srcVec = vec3norm(vec3sub(srcDir, srcAnchor));
  const tgtVec = vec3norm(vec3sub(dirBoat, anchorBoat));
  if (vec3len(srcVec) < 1e-9 || vec3len(tgtVec) < 1e-9) return null;

  let R;
  if (rollIdx != null && rollBoat && worldLandmarks[rollIdx]) {
    const srcRoll = worldLandmarks[rollIdx];
    R = rotationFromTwoVectors(
      vec3sub(srcDir, srcAnchor), vec3sub(srcRoll, srcAnchor),
      vec3sub(dirBoat, anchorBoat), vec3sub(rollBoat, anchorBoat)
    );
  } else {
    R = rotationFromAToB(srcVec, tgtVec);
  }

  // Apply: R * (pt - srcAnchor) + anchorBoat
  const placed = {};
  for (let i = 0; i < 33; i++) {
    const lm = worldLandmarks[i];
    if (!lm) continue;
    placed[i] = vec3add(mat3vec(R, vec3sub(lm, srcAnchor)), anchorBoat);
  }

  // Flip check: shoulders should be above hips
  const sZ = _avgZ(placed, [11, 12]);
  const hZ = _avgZ(placed, [23, 24]);
  if (sZ !== null && hZ !== null && sZ < hZ - 0.05) {
    // Flip 180° around the primary axis direction
    const flipR = rotationFromAToB([0, 0, 1], [0, 0, -1]);
    const midHip = placed[23] && placed[24]
      ? vec3scale(vec3add(placed[23], placed[24]), 0.5) : anchorBoat;
    for (let i = 0; i < 33; i++) {
      if (!placed[i]) continue;
      placed[i] = vec3add(mat3vec(flipR, vec3sub(placed[i], midHip)), midHip);
    }
  }

  return placed;
}

// ── Exports for testing / direct use ──────────────────────────────────

export {
  mat3mul, mat3T, mat3vec,
  vec3add, vec3sub, vec3scale, vec3dot, vec3cross, vec3len, vec3norm,
  rotX, rotY, rotZ,
  rotationFromAToB, rotationFromTwoVectors,
  rayFromNormLandmark as rayFromNormLandmarkUndistorted,
};
