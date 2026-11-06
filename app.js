/*
 * HIDDEN SIDE v0.2 — p5.js 1.11.13 + WebGL1
 * GPU処理はp5.jsのWebGL1コンテキストを直接利用。入力テクスチャは再利用し、プレビューと書き出しの描画解像度を分離。
 * 画像／映像はローカルで処理し、サーバーへアップロードしない。
 * 書き出しは実時間のMediaRecorder録画。初期版は無音・最大45秒。
 */
'use strict';

const MODES = [
  '暗部が空洞化し、皮膚や物質の境界から異質な色層が浮き上がる。',
  '銀塩ネガのような明暗反転。青い輪郭と残された色温度が漂う。',
  '明度勾配を仮想的な凹凸へ変換。光の方向で表面を発掘する。',
  '像の境界から色が滲み、膜と染みが互いを侵食する。',
  '輪郭と色の位置がずれて、同じ像の複数の時間が重なる。'
];
const $ = (id) => document.getElementById(id);
const dom = {};
const isTouchDevice = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent);
const MAX_RECORD_SECONDS = 45;
// 通常表示の長辺を抑え、録画開始時のみ高解像度に切り替える。
const PERFORMANCE = {
  eco: { preview: 520, video: 720, fps: 24 },
  balanced: { preview: 720, video: 960, fps: 24 },
  fine: { preview: 960, video: 1280, fps: 30 }
};
const MAX_PHOTO_SOURCE = 2048;
const MAX_HISTORY_EDGE = 512;


const state = {
  type: 'none', element: null, fileName: '', objectUrl: null,
  mode: 0, seed: 11.726, depth: 0.62, erosion: 0.56, drift: 0.24,
  w: 4, h: 4, originalW: 4, originalH: 4,
  renderW: 4, renderH: 4, sourceW: 0, sourceH: 0,
  quality: 'balanced', frameDirty: false, frameTime: -1, imageReady: false,
  videoReady: false, isRecording: false, recorder: null, stream: null,
  recordStartedAt: 0, recordedBlob: null, recordedName: '',
  pointer: [0.5, 0.5], touchForce: 0, touchTarget: 0,
  activeURL: null, firstDraw: true, renderingError: false,
  historyReady: false, historyW: 0, historyH: 0
};

let gl, canvas, program, sourceTexture, buffer, sourceCanvas, sourceCtx, u;
let feedbackTextures = [], feedbackFramebuffer = null, feedbackReadIndex = 0;
let aPosition = -1, aUv = -1;
let lastTimestamp = performance.now();

// p5.jsの描画ライフサイクル。UIは通常のDOMで管理する。
function setup() {
  setAttributes({ version: 1, alpha: false, depth: false, stencil: false,
    antialias: false, preserveDrawingBuffer: true });
  pixelDensity(1);
  const p5Canvas = createCanvas(4, 4, WEBGL);
  p5Canvas.parent('canvas-host');
  canvas = p5Canvas.elt;
  frameRate(PERFORMANCE[state.quality].fps);
  try { initGL(); }
  catch (error) {
    state.renderingError = true;
    setStatus(`WebGLを初期化できません: ${error.message}`, true);
    console.error(error);
  }
  resizePreview();
  // iOSがGPUを回収した場合、ユーザー操作を失わずテクスチャを再構築する。
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    state.renderingError = true;
    if (state.isRecording) stopRecording();
    setStatus('GPU接続が一時的に失われました。復旧を待っています。', true);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      initGL();
      if (state.imageReady) {
        allocateSourceTexture(state.sourceW, state.sourceH);
        state.frameDirty = true;
      }
      initFeedback();
      state.renderingError = false;
      setStatus('GPUを再初期化しました。');
    } catch (error) { setStatus(`GPU復旧エラー: ${error.message}`, true); }
  });
}

function draw() {
  if (!gl || state.renderingError) return;
  if (document.hidden) return;
  if (state.type === 'none' || !state.imageReady) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.036, 0.034, 0.033, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }

  const now = performance.now();
  const dt = Math.min((now - lastTimestamp) / 1000, 0.1);
  lastTimestamp = now;
  state.touchForce += (state.touchTarget - state.touchForce) * Math.min(1, dt * 8);

  try {
    if (state.type === 'video' && state.element && state.element.readyState >= 2) {
      const current = state.element.currentTime;
      if (state.frameDirty || (current !== state.frameTime && !state.element.seeking)) {
        sourceCtx.drawImage(state.element, 0, 0, state.sourceW, state.sourceH);
        uploadSource();
        state.frameDirty = false;
        state.frameTime = current;
      }
      $('timecode').textContent = secondsToClock(current);
      if (state.isRecording && (current >= MAX_RECORD_SECONDS ||
          (Number.isFinite(state.element.duration) && current >= state.element.duration - 0.025))) {
        stopRecording();
      }
    } else if (state.type === 'photo' && state.frameDirty) {
      sourceCtx.drawImage(state.element, 0, 0, state.sourceW, state.sourceH);
      uploadSource();
      state.frameDirty = false;
    }
    renderFrame(now * 0.001);
  } catch (error) {
    // 端末依存の一時的な動画フレーム未準備は次フレームで再試行。
    if (state.type === 'video') state.frameDirty = true;
    if (!state.renderingError) {
      setStatus(`描画エラー: ${error.message}`, true);
      console.error(error);
      // 動画フレームの一時的な転送失敗は次フレームで復帰を試みる。
      if (state.type !== 'video') state.renderingError = true;
    }
  }
}

const VERTEX_SHADER = `
  precision highp float;
  attribute vec2 a_position;
  attribute vec2 a_uv;
  varying vec2 v_uv;
  void main() {
    v_uv = a_uv;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_source;
  uniform sampler2D u_history;
  uniform float u_historyMix;
  uniform vec2 u_texel;
  uniform vec2 u_resolution;
  uniform vec2 u_pointer;
  uniform float u_touch;
  uniform float u_time;
  uniform float u_seed;
  uniform float u_mode;
  uniform float u_depth;
  uniform float u_erosion;
  uniform float u_drift;

  float sat(float v) { return clamp(v, 0.0, 1.0); }
  vec3 sat3(vec3 v) { return clamp(v, 0.0, 1.0); }
  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 s = f*f*(3.0-2.0*f);
    return mix(mix(hash21(i), hash21(i+vec2(1.,0.)), s.x),
               mix(hash21(i+vec2(0.,1.)), hash21(i+vec2(1.,1.)), s.x), s.y);
  }
  float fbm(vec2 p) {
    float n = .0; float a = .5;
    for (int i=0; i<4; i++) { n += a * noise2(p); p = p*2.07+vec2(12.3,5.4); a *= .5; }
    return n;
  }
  vec3 src(vec2 uv) { return texture2D(u_source, clamp(uv, vec2(.001), vec2(.999))).rgb; }

  void main() {
    vec2 uv = v_uv;
    vec2 ax = vec2(u_resolution.x/u_resolution.y, 1.0);
    float t = u_time * u_drift;
    float e = u_erosion;
    float d = u_depth;
    vec2 wavep = uv * vec2(5.7, 9.1) + vec2(u_seed, u_seed*.31);
    float n = fbm(wavep + vec2(t*.27, -t*.19));
    float medium = fbm(wavep*2.8 - vec2(t*.31, -t*.23));
    float micro = hash21(floor(uv * u_resolution * .54) + u_seed * 13.5);

    // 指で触れた部分だけ、階調の内部に局所的な変形場が生まれる。
    float dist = length((uv-u_pointer)*ax);
    float probe = exp(-dist*dist / (.019 + d*.011)) * u_touch;
    vec2 flow = vec2(noise2(wavep*1.6 + t*.4) - .5, noise2(wavep*1.5 + 12.8 - t*.35) - .5);
    vec2 displaced = uv + flow * (.002 + e * .013) * (0.3 + u_drift)
                       + flow * probe * .054;

    // GHOSTのみ明確に大きい色ずれ。他モードは微細な肌理のずれに留める。
    if (u_mode > 3.5) {
      float row = floor(uv.y * 118.0 + t*1.7);
      float breakRow = step(.944 - .035*e, hash21(vec2(row, floor(t*.7)+u_seed)));
      displaced.x += breakRow * (noise2(vec2(row,t+u_seed))-.5) * (.07 * e);
    }
    displaced = clamp(displaced, vec2(.001), vec2(.999));
    vec3 c = src(displaced);
    float l = lum(c);
    vec2 gStep = u_texel * (1.35 + 1.6*d);
    float gx = lum(src(displaced+vec2(gStep.x,0.))) - lum(src(displaced-vec2(gStep.x,0.)));
    float gy = lum(src(displaced+vec2(0.,gStep.y))) - lum(src(displaced-vec2(0.,gStep.y)));
    float edge = sat(length(vec2(gx,gy)) * (3.4+5.2*d));
    float outline = smoothstep(.13, .48, edge);
    float organ = n*.74 + medium*.26;
    vec3 outColor = c;

    if (u_mode < .5) {
      // UNDER: 色層のトポロジーを形成し、暗部を洞穴にする。
      float stratum = l + (organ-.48)*(.18+.35*e) + (micro-.5)*(.055*e);
      float a = smoothstep(.15-.06*d,.43-.06*d,stratum);
      float b = smoothstep(.44-.04*d,.70-.04*d,stratum);
      float ctop = smoothstep(.63-.05*d,.84-.03*d,stratum+medium*.09);
      vec3 ink = vec3(.015,.004,.036);
      vec3 purple = vec3(.21,.026,.46);
      vec3 flesh = vec3(.79,.53,.69);
      vec3 acid = vec3(.52,.60,.026);
      outColor = mix(ink, purple, a);
      outColor = mix(outColor, flesh, b);
      float acidVeins = ctop * (smoothstep(.3,.75,medium) * .65 + outline * .32);
      outColor = mix(outColor, acid, sat(acidVeins)*.92);
      outColor = mix(outColor, vec3(.008,.006,.012), outline*(.72+.18*d));
      outColor += (micro-.5)*(.09*e);
    }
    else if (u_mode < 1.5) {
      // NEGATIVE: 高キーのネガに温かい肉色と青い電位境界を重ねる。
      vec3 neg = pow(sat3(1.0 - c), vec3(.8+.22*d));
      outColor = mix(neg, vec3(.89,.92,.95), .12 + e*.18);
      float warmth = smoothstep(.2,.63,l) * (1.0-smoothstep(.63,.95,l));
      outColor = mix(outColor, vec3(.44,.26,.34), warmth*(.24+.40*d));
      float cyanRim = outline * (.45+.4*e);
      outColor = mix(outColor, vec3(.012,.62,.82), cyanRim);
      outColor = mix(outColor, vec3(.25,.20,.40), (micro-.53)*e*.16);
    }
    else if (u_mode < 2.5) {
      // RELIEF: 元画像の明度を高さ場として解釈。勾配から仮想法線を導出。
      vec3 normal = normalize(vec3(-gx*(4.+d*9.), -gy*(4.+d*9.), .35+ .15*(1.-d)));
      vec3 sun = normalize(vec3(-.72,.52,.7));
      float light = sat(dot(normal,sun)*.63+.32);
      float elevation = l + (organ-.5)*.16*e;
      float contour = 1.0-smoothstep(.015,.065,abs(fract(elevation*(10.+d*24.))-.5));
      vec3 chalk = mix(vec3(.10,.09,.115),vec3(.65,.60,.53),light);
      chalk = mix(chalk, vec3(.91,.83,.72), smoothstep(.48,.88,elevation)*.6);
      outColor = mix(chalk,vec3(.045,.046,.055), contour * (.25+.48*e));
      outColor = mix(outColor,vec3(.03,.03,.04),outline*.36);
      outColor += (micro-.5)*e*.14;
    }
    else if (u_mode < 3.5) {
      // SEEP: ハイライトで漂白、境界で色素沈着、陰に膜状の暗い空洞。
      float liquid = l + (organ-.52)*(.45*e) - outline*.17;
      float stain = smoothstep(.24-.12*d,.52,liquid);
      float crust = smoothstep(.48,.79,liquid + medium*.17);
      vec3 black = vec3(.018,.019,.026);
      vec3 lilac = vec3(.44,.24,.68);
      vec3 pallid = vec3(.83,.73,.74);
      outColor = mix(black,lilac,stain);
      outColor = mix(outColor,pallid,crust);
      float seep = smoothstep(.55,.83,organ+outline*.24) * (1.0-smoothstep(.85,1.0,l));
      outColor = mix(outColor,vec3(.68,.72,.065),seep*(.28+.65*e));
      outColor *= (1.0-.53*outline);
      outColor += (micro-.5)*.12*e;
    }
    else {
      // GHOST: 異なる方向にずれた輪郭を再合成し、時間のずれを疑似生成。
      vec2 shift = vec2(.003 + .026*e, .002 + .013*e);
      shift *= vec2(sin(t*.32+u_seed)*.5+.7, cos(t*.3+u_seed)*.5+.7);
      vec3 right = src(displaced + shift + flow*.016);
      vec3 left = src(displaced - shift*1.6);
      vec3 ghost = vec3(right.r, c.g*.55 + right.b*.28 + left.g*.17, left.b);
      float corridor = fbm(uv*vec2(20.,8.)+vec2(-t*.33,u_seed));
      outColor = mix(ghost, vec3(.035,.04,.055), .22+.21*d);
      outColor += vec3(.20,.04,.33)*outline*(.18+.42*e);
      outColor += vec3(.01,.14,.15)*(corridor-.48)*e*.55;
      outColor += (micro-.5)*e*.065;
      // 現在の映像に「実際の過去フレーム」を低解像度フィードバック。
      // 履歴の更新は別の小さなFBOで行うため、入力が4KでもGPUメモリを節約できる。
      vec2 pastUv = clamp(uv + flow*(.003 + e*.018) + vec2(sin(t*.6),cos(t*.41))*.0025,
                          vec2(.001), vec2(.999));
      vec3 residual = texture2D(u_history, pastUv).rgb;
      float persistence = (.21 + .45*d) * u_historyMix;
      outColor = mix(outColor, residual, persistence);
    }

    // タッチ時だけ表面の下から輪郭が現れる。静止画でも動画でも共通。
    outColor = mix(outColor,
      mix(outColor, vec3(.95,.89,.72), sat(outline + .13)) + vec3(.07,.02,.11),
      probe * (.26+.44*d));
    outColor = sat3(outColor);
    gl_FragColor = vec4(outColor, 1.0);
  }
`;

function compileShader(type, text) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, text);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}
function initGL() {
  gl = drawingContext;
  const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  program = gl.createProgram();
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vs); gl.deleteShader(fs);
  gl.useProgram(program);
  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // X/Yはクリップ空間、U/Vは左下=(0,0)、右上=(1,1)。
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([
    -1,-1,0,0, 1,-1,1,0, -1,1,0,1,
    -1,1,0,1, 1,-1,1,0, 1,1,1,1
  ]),gl.STATIC_DRAW);
  aPosition = gl.getAttribLocation(program,'a_position');
  aUv = gl.getAttribLocation(program,'a_uv');
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition,2,gl.FLOAT,false,16,0);
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv,2,gl.FLOAT,false,16,8);
  sourceTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,sourceTexture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,
    new Uint8Array([0,0,0,255]));
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  u = {};
  for (const name of ['u_source','u_history','u_historyMix',
      'u_texel','u_resolution','u_pointer','u_touch',
      'u_time','u_seed','u_mode','u_depth','u_erosion','u_drift']) {
    u[name] = gl.getUniformLocation(program,name);
  }
  gl.uniform1i(u.u_source,0);
  gl.uniform1i(u.u_history,1);
  sourceCanvas = document.createElement('canvas');
  sourceCtx = sourceCanvas.getContext('2d',{alpha:false});
  if (!sourceCtx) throw new Error('画像縮小用Canvas 2Dを作成できません。');
}

// 入力のサイズが変わるときだけGPUメモリを確保し、通常フレームはsubImageで更新する。
function allocateSourceTexture(w, h) {
  state.sourceW = w;
  state.sourceH = h;
  sourceCanvas.width = w;
  sourceCanvas.height = h;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  state.frameDirty = true;
  state.frameTime = -1;
}
function uploadSource() {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
}
function sizeForLimit(w, h, edge) {
  const scale = Math.min(1, edge / Math.max(w, h));
  return [Math.max(2, Math.floor(w * scale / 2) * 2),
          Math.max(2, Math.floor(h * scale / 2) * 2)];
}
function previewSize() {
  return sizeForLimit(state.originalW, state.originalH, PERFORMANCE[state.quality].preview);
}
function exportSize() {
  const edge = state.type === 'video' ? PERFORMANCE[state.quality].video : MAX_PHOTO_SOURCE;
  return sizeForLimit(state.originalW, state.originalH, edge);
}
function resetFeedback() {
  state.historyReady = false;
  feedbackReadIndex = 0;
  if (!gl || !feedbackTextures.length) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, feedbackFramebuffer);
  for (const tex of feedbackTextures) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
function initFeedback() {
  // GPU内の2枚の小さなテクスチャを交互に更新。CPUへの読み戻しは行わない。
  for (const tex of feedbackTextures) gl.deleteTexture(tex);
  if (feedbackFramebuffer) gl.deleteFramebuffer(feedbackFramebuffer);
  feedbackTextures = [];
  feedbackFramebuffer = gl.createFramebuffer();
  [state.historyW, state.historyH] = sizeForLimit(canvas.width, canvas.height, MAX_HISTORY_EDGE);
  for (let i=0; i<2; i++) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,state.historyW,state.historyH,0,
      gl.RGBA,gl.UNSIGNED_BYTE,null);
    feedbackTextures.push(tex);
  }
  resetFeedback();
  gl.activeTexture(gl.TEXTURE0);
}
function drawPass(targetFramebuffer, w, h, now) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
  gl.viewport(0,0,w,h);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.enableVertexAttribArray(aPosition);gl.vertexAttribPointer(aPosition,2,gl.FLOAT,false,16,0);
  gl.enableVertexAttribArray(aUv);gl.vertexAttribPointer(aUv,2,gl.FLOAT,false,16,8);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,sourceTexture);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,feedbackTextures[feedbackReadIndex]);
  gl.uniform1i(u.u_source,0);
  gl.uniform1i(u.u_history,1);
  gl.uniform1f(u.u_historyMix, state.mode===4 && state.historyReady ? 1 : 0);
  gl.uniform2f(u.u_texel,1/state.sourceW,1/state.sourceH);
  gl.uniform2f(u.u_resolution,w,h);
  gl.uniform2f(u.u_pointer,state.pointer[0],state.pointer[1]);
  gl.uniform1f(u.u_touch,state.touchForce);
  gl.uniform1f(u.u_time,now);
  gl.uniform1f(u.u_seed,state.seed);
  gl.uniform1f(u.u_mode,state.mode);
  gl.uniform1f(u.u_depth,state.depth);
  gl.uniform1f(u.u_erosion,state.erosion);
  gl.uniform1f(u.u_drift,state.drift);
  gl.drawArrays(gl.TRIANGLES,0,6);
}
function renderFrame(now, updateHistory=true) {
  if (!state.imageReady || !feedbackTextures.length) return;
  // 常時表示は小さなキャンバスだけ。GHOST以外は1回のドローコール。
  drawPass(null, canvas.width, canvas.height, now);
  if (state.mode===4 && updateHistory) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, feedbackFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,
      feedbackTextures[1-feedbackReadIndex],0);
    drawPass(feedbackFramebuffer,state.historyW,state.historyH,now);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    feedbackReadIndex=1-feedbackReadIndex;
    state.historyReady=true;
  }
  gl.activeTexture(gl.TEXTURE0);
}
function setRenderSize(w,h,clearHistory=false) {
  if (!canvas || !gl) return;
  if (canvas.width!==w || canvas.height!==h) {
    resizeCanvas(w,h,true);
    // p5.jsが内部的にframebufferを変更することがあるため再設定する。
    state.renderW=w;state.renderH=h;
    initFeedback();
  } else if(clearHistory) resetFeedback();
  resizePreview();
}
function setSourceDimensions(w,h) {
  state.originalW=w;state.originalH=h;
  // 静止画は読み込み時だけ縮小。動画はプレビューと記録で入力縮小サイズを変える。
  const [sw,sh]=state.type==='photo' ? sizeForLimit(w,h,MAX_PHOTO_SOURCE) : previewSize();
  allocateSourceTexture(sw,sh);
  const [pw,ph]=previewSize();
  setRenderSize(pw,ph,true);
  $('dimensionsTag').textContent=`${pw} × ${ph} · GPU`;
}
function changeVideoSourceSize(w,h) {
  if(state.type!=='video')return;
  if(state.sourceW!==w || state.sourceH!==h) allocateSourceTexture(w,h);
  state.frameDirty=true;
}
function changeQuality(q) {
  if (!PERFORMANCE[q] || state.isRecording) return;
  state.quality=q;
  frameRate(PERFORMANCE[q].fps);
  if(state.imageReady){
    const [w,h]=previewSize();
    if(state.type==='video')changeVideoSourceSize(w,h);
    setRenderSize(w,h,true);
    $('dimensionsTag').textContent=`${w} × ${h} · GPU`;
    if(state.type==='photo')state.frameDirty=true;
  }
  setStatus(`GPU ${q.toUpperCase()} · プレビュー長辺 ${PERFORMANCE[q].preview}px · 保存時は高解像度`);
}

function resizePreview() {
  if (!canvas) return;
  const box = $('stage').getBoundingClientRect();
  const scale = Math.min((box.width-4)/canvas.width,(box.height-4)/canvas.height);
  canvas.style.width=`${Math.max(2,canvas.width*scale)}px`;
  canvas.style.height=`${Math.max(2,canvas.height*scale)}px`;
}
function clearPreviousSource() {
  if (state.isRecording) stopRecording();
  const video=$('sourceVideo');
  video.pause(); video.onended=null; video.removeAttribute('src'); video.load();
  if (state.objectUrl) {URL.revokeObjectURL(state.objectUrl); state.objectUrl=null;}
  state.type='none'; state.element=null; state.frameDirty=false; state.imageReady=false;
  resetFeedback();
  state.videoReady=false; state.renderingError=false;
  state.frameTime=-1; state.touchForce=0; state.touchTarget=0;
  clearExport();
}
async function openFile(file) {
  if (!file || state.isRecording) return;
  if (!gl || !sourceCtx || !program) {setStatus('この端末ではWebGLを利用できません。',true);return;}
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(heic|heif|png|jpeg|jpg|webp)$/i.test(file.name);
  if (!isVideo && !isImage) {setStatus('画像または動画を選択してください。',true);return;}
  clearPreviousSource();
  state.type=isVideo?'video':'photo'; state.fileName=file.name;
  state.objectUrl=URL.createObjectURL(file);
  $('assetName').textContent=file.name;
  $('sourceTag').textContent=isVideo?'VIDEO INPUT':'STILL INPUT';
  $('emptyState').hidden=true;
  // emptyStateはCSSがdisplay:flexを定義するので明示的に隠す。
  $('emptyState').style.display='none';
  $('stage').classList.add('has-source');
  $('saveButton').disabled=true;
  $('playButton').disabled=true;
  $('recordButton').disabled=true;
  setStatus('メディアを読み込んでいます…');
  try {
    if (isVideo) {
      const video=$('sourceVideo');
      state.element=video;
      video.loop=true; video.muted=true; video.playsInline=true;
      video.src=state.objectUrl;
      video.load();
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('動画の読み込みがタイムアウトしました。')),18000);
        video.addEventListener('loadedmetadata',()=>{clearTimeout(timeout);resolve();},{once:true});
        video.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('この動画形式を再生できません。'));},{once:true});
      });
      setSourceDimensions(video.videoWidth,video.videoHeight);
      state.imageReady=true; state.videoReady=true; state.frameDirty=true;
      video.ontimeupdate=()=>{state.frameDirty=true;};
      if (typeof video.requestVideoFrameCallback === 'function') {
        const onVideoFrame=()=>{
          if(state.element!==video || state.type!=='video')return;
          state.frameDirty=true;
          video.requestVideoFrameCallback(onVideoFrame);
        };
        video.requestVideoFrameCallback(onVideoFrame);
      }
      video.onended=()=>{if(state.isRecording)stopRecording();};
      $('timecode').textContent=secondsToClock(0);
      $('playButton').disabled=false;
      $('recordButton').disabled=false;
      $('saveButton').disabled=false;
      $('playLabel').textContent='PAUSE'; $('playIcon').textContent='Ⅱ';
      // 読み込み自体がファイル選択の操作に続いており、ミュート動画の再生は通常許可される。
      let started = true;
      try {await video.play();} catch {
        started = false;
        $('playLabel').textContent='PLAY'; $('playIcon').textContent='▶';
      }
      setStatus(started ? `VIDEO READY · ${secondsToClock(video.duration)} · 保存は無音 / 最大45秒`
        : '動画を読み込みました。PLAYを押して再生してください。');
    } else {
      const img=new Image();
      state.element=img;
      await new Promise((resolve,reject)=>{
        img.onload=resolve;
        img.onerror=()=>reject(new Error('この画像を開けません。形式を確認してください。'));
        img.src=state.objectUrl;
      });
      setSourceDimensions(img.naturalWidth,img.naturalHeight);
      state.imageReady=true; state.frameDirty=true;
      $('timecode').textContent='STILL';
      $('saveButton').disabled=false;
      setStatus('IMAGE READY · 画面を指でなぞると局所的に変化します。');
    }
  } catch (error) {
    setStatus(error.message,true);
    console.error(error);
    $('emptyState').style.display='flex'; $('stage').classList.remove('has-source');
    clearPreviousSource();
  }
}

function secondsToClock(t) {
  if (!Number.isFinite(t)||t<0) return '--:--';
  const n=Math.floor(t);
  return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
}
function setStatus(message, error=false) {
  if (!$('status')) return;
  $('status').textContent=message;
  $('status').style.color=error?'#f6a69f':'#86847c';
}
function togglePlay() {
  if (state.type!=='video'||!state.videoReady) return;
  const v=state.element;
  if (state.isRecording) {stopRecording();return;}
  if (v.paused) {
    v.play().then(()=>{$('playLabel').textContent='PAUSE';$('playIcon').textContent='Ⅱ';})
      .catch(err=>setStatus(`再生できません: ${err.message}`,true));
  } else {
    v.pause();
    $('playLabel').textContent='PLAY';$('playIcon').textContent='▶';
  }
}
function toBlobAsync(c,type,quality) {
  return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('画像の書き出しに失敗しました。')),type,quality));
}
function safeBaseName(name) {
  return (name||'capture').replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9ぁ-んァ-ン一-龥_\-]/g,'_').slice(0,55);
}
function downloadBlob(blob,name) {
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function shareOrSave(blob,name,preferShare=true) {
  const file=new File([blob],name,{type:blob.type});
  if (preferShare && navigator.share && navigator.canShare && navigator.canShare({files:[file]})) {
    try {await navigator.share({files:[file],title:'HIDDEN SIDE'});return;}
    catch (e) {if (e.name==='AbortError') return;}
  }
  downloadBlob(blob,name);
}
async function saveStill() {
  if (!state.imageReady) return;
  try {
    const originalSize=[canvas.width,canvas.height];
    const [exportW,exportH]=exportSize();
    try {
      setRenderSize(exportW,exportH,false);
      if (state.frameDirty && state.type==='photo') {
        sourceCtx.drawImage(state.element,0,0,state.sourceW,state.sourceH);
        uploadSource();
        state.frameDirty=false;
      }
      renderFrame(performance.now()*.001,false);
      const blob=await toBlobAsync(canvas,'image/png');
      const name=`hidden_${safeBaseName(state.fileName)}_m${state.mode+1}.png`;
      // 共有画面の表示中に高解像度描画を続けないよう、先にプレビューへ戻す。
      setRenderSize(...originalSize);
      await shareOrSave(blob,name,true);
      setStatus(`IMAGE EXPORTED · ${exportW} × ${exportH}`);
    } finally {
      if(canvas.width!==originalSize[0] || canvas.height!==originalSize[1]) setRenderSize(...originalSize);
    }
  } catch(error) {setStatus(`保存エラー: ${error.message}`,true);console.error(error);}
}
function pickMimeType() {
  if (typeof MediaRecorder==='undefined') return null;
  // iPhoneはMP4優先。非対応環境ではWebMを選択し、拡張子も合わせる。
  const types=['video/mp4;codecs=avc1.42E01E','video/mp4;codecs=avc1.424028',
    'video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
  return types.find(t=>MediaRecorder.isTypeSupported(t)) || '';
}
async function startRecording() {
  if (state.type!=='video'||!state.videoReady||state.isRecording) return;
  if (typeof canvas.captureStream!=='function'||typeof MediaRecorder==='undefined') {
    setStatus('このブラウザでは動画の録画APIが使えません。',true);return;
  }
  clearExport();
  let stream;
  try {
    const v=state.element;
    v.pause();v.loop=false;
    v.currentTime=0;
    // 先頭フレームへのシーク後に録画を開始する。
    if (v.seeking) await new Promise(resolve=>{
      const timeout=setTimeout(resolve,2000);
      v.addEventListener('seeked',()=>{clearTimeout(timeout);resolve();},{once:true});
    });
    state.frameDirty=true;
    const [recordW,recordH]=exportSize();
    changeVideoSourceSize(recordW,recordH);
    setRenderSize(recordW,recordH,true);
    if (v.readyState>=2) {
      sourceCtx.drawImage(v,0,0,state.sourceW,state.sourceH);
      uploadSource();
      state.frameDirty=false;
      renderFrame(performance.now()*.001);
    }
    stream=canvas.captureStream(PERFORMANCE[state.quality].fps);
    const mime=pickMimeType();
    const opts={videoBitsPerSecond: Math.max(2000000,Math.min(7000000,recordW*recordH*5.0))};
    if(mime)opts.mimeType=mime;
    const recorder=new MediaRecorder(stream,opts);
    const chunks=[];
    state.stream=stream;state.recorder=recorder;
    recorder.ondataavailable=(event)=>{if(event.data&&event.data.size)chunks.push(event.data);};
    recorder.onerror=event=>{setStatus(`録画エラー: ${event.error?.message||'不明なエラー'}`,true);stopRecording();};
    recorder.onstop=()=>{
      stream.getTracks().forEach(track=>track.stop());
      state.isRecording=false;state.recorder=null;state.stream=null;
      document.body.classList.remove('is-recording');
      $('recordLabel').textContent='RECORD'; $('recState').textContent='';
      if(state.type==='video') {
        state.element.loop=true;
        const [pw,ph]=previewSize();
        changeVideoSourceSize(pw,ph);
        setRenderSize(pw,ph,true);
        $('dimensionsTag').textContent=`${pw} × ${ph} · GPU`;
      }
      if(chunks.length===0){setStatus('映像データが作成されませんでした。',true);return;}
      const actualMime=recorder.mimeType || (mime||'video/mp4');
      const extension=/webm/i.test(actualMime)?'webm':'mp4';
      const blob=new Blob(chunks,{type:actualMime});
      state.recordedBlob=blob;
      state.recordedName=`hidden_${safeBaseName(state.fileName)}_${Date.now()}.${extension}`;
      $('exportDetails').textContent=`${secondsToClock(Math.min(v.currentTime,MAX_RECORD_SECONDS))} / ${recordW} × ${recordH} / ${extension.toUpperCase()} / 無音 / ${(blob.size/1048576).toFixed(1)} MB`;
      $('exportPanel').hidden=false;
      $('shareVideo').disabled=!(navigator.share && navigator.canShare && navigator.canShare({files:[new File([blob],state.recordedName,{type:blob.type})]}));
      setStatus('VIDEO READY · 「共有」または「ファイル保存」を選択してください。');
    };
    recorder.start(500);
    state.isRecording=true;state.recordStartedAt=performance.now();
    document.body.classList.add('is-recording');
    $('recordLabel').textContent='STOP';$('recState').textContent='● REC 00:00';
    // プレビューがすでに開始済みである場合も、必ず先頭から再生する。
    await v.play();
    $('playLabel').textContent='PAUSE';$('playIcon').textContent='Ⅱ';
    setStatus('RECORDING · 動画を実時間で処理中。上限45秒 / 無音');
  } catch(error) {
    if(state.recorder && state.recorder.state!=='inactive')state.recorder.stop();
    else if(stream)stream.getTracks().forEach(track=>track.stop());
    state.isRecording=false;
    if(state.type==='video') {
      const [pw,ph]=previewSize();
      changeVideoSourceSize(pw,ph);
      setRenderSize(pw,ph,true);
    }
    document.body.classList.remove('is-recording');
    $('recordLabel').textContent='RECORD';$('recState').textContent='';
    setStatus(`録画を開始できません: ${error.message}`,true);
    console.error(error);
  }
}
function stopRecording() {
  if(!state.isRecording || !state.recorder) return;
  const recorder=state.recorder;
  state.isRecording=false;
  if(state.type==='video' && state.element)state.element.pause();
  if(recorder.state!=='inactive')recorder.stop();
}
function clearExport() {state.recordedBlob=null;state.recordedName='';$('exportPanel').hidden=true;}
function setMode(mode) {
  if (state.mode!==mode) resetFeedback();
  state.mode=mode;
  $('modeDescription').textContent=MODES[mode];
  $('modeIndex').textContent=String(mode+1).padStart(2,'0')+' / 05';
  document.querySelectorAll('.mode-button').forEach(b=>{
    const active=Number(b.dataset.mode)===mode;
    b.classList.toggle('active',active);
    b.setAttribute('aria-pressed',String(active));
  });
}

function bindEvents() {
  ['depth','erosion','drift'].forEach(id=>{
    $(id).addEventListener('input',()=>{
      const val=Number($(id).value);
      state[id]=val/100;
      $(id+'Value').textContent=String(val).padStart(2,'0');
    });
  });
  document.querySelectorAll('.mode-button').forEach(button=>{
    button.addEventListener('click',()=>setMode(Number(button.dataset.mode)));
  });
  $('reroll').addEventListener('click',()=>{
    state.seed=Math.random()*120+1;resetFeedback();setStatus('MATERIAL PATTERN RESEEDED');
  });
  $('renderQuality').addEventListener('change',e=>changeQuality(e.target.value));
  $('importButton').addEventListener('click',()=>{if(!state.isRecording)$('fileInput').click();});
  $('emptyImport').addEventListener('click',()=>$('fileInput').click());
  $('fileInput').addEventListener('change',async event=>{
    const f=event.target.files?.[0];
    event.target.value='';
    if(f)await openFile(f);
  });
  $('playButton').addEventListener('click',togglePlay);
  $('saveButton').addEventListener('click',saveStill);
  $('recordButton').addEventListener('click',()=>state.isRecording?stopRecording():startRecording());
  $('closeExport').addEventListener('click',()=>$('exportPanel').hidden=true);
  $('downloadVideo').addEventListener('click',()=>{
    if(state.recordedBlob)downloadBlob(state.recordedBlob,state.recordedName);
  });
  $('shareVideo').addEventListener('click',()=>{
    if(state.recordedBlob)shareOrSave(state.recordedBlob,state.recordedName,true);
  });
  $('exportPanel').addEventListener('click',e=>{
    if(e.target===$('exportPanel'))$('exportPanel').hidden=true;
  });
  $('canvas-host').addEventListener('pointerdown',event=>{
    if(!state.imageReady)return;
    updateTouch(event);state.touchTarget=1;
    if(event.target===canvas) canvas.setPointerCapture(event.pointerId);
  });
  $('canvas-host').addEventListener('pointermove',event=>{
    if(state.touchTarget>0)updateTouch(event);
  });
  ['pointerup','pointercancel','pointerleave'].forEach(type=>{
    $('canvas-host').addEventListener(type,()=>{state.touchTarget=0;});
  });
  $('stage').addEventListener('dragover',event=>event.preventDefault());
  $('stage').addEventListener('drop',event=>{
    event.preventDefault();if(event.dataTransfer?.files?.[0])openFile(event.dataTransfer.files[0]);
  });
  window.addEventListener('resize',resizePreview,{passive:true});
  if (typeof ResizeObserver!=='undefined') new ResizeObserver(resizePreview).observe($('stage'));
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&state.isRecording)stopRecording();
  });
  setMode(0);
  $('renderQuality').value=state.quality;
  setInterval(()=>{
    if(state.isRecording){
      const elapsed=Math.min(MAX_RECORD_SECONDS,(performance.now()-state.recordStartedAt)/1000);
      $('recState').textContent=`● REC ${secondsToClock(elapsed)}`;
    }
  },250);
}
function updateTouch(event) {
  const rect=canvas.getBoundingClientRect();
  state.pointer=[
    Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),
    Math.max(0,Math.min(1,1-(event.clientY-rect.top)/rect.height))
  ];
}

document.addEventListener('DOMContentLoaded',()=>{
  bindEvents();
  if ('serviceWorker' in navigator && location.protocol==='https:') {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
});
