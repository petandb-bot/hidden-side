/* HIDDEN SIDE v0.3.2 | p5.js 1.11.13 | WebGL1 | local GPU processing */
'use strict';

const $ = (id) => document.getElementById(id);
const dom = {};
const isTouchDevice = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent);
const MAX_RECORD_SECONDS = 45;
const PERFORMANCE = {
  eco: { preview: 520, video: 720, fps: 24 },
  balanced: { preview: 720, video: 960, fps: 24 },
  fine: { preview: 960, video: 1280, fps: 30 }
};
const MAX_PHOTO_SOURCE = 2048;
const MAX_HISTORY_EDGE = 448;


const state = {
  type: 'none', element: null, fileName: '', objectUrl: null,
  mode: 0, seed: 11.726, depth: 0.48, erosion: 0.34, drift: 0.20,
  w: 4, h: 4, originalW: 4, originalH: 4,
  renderW: 4, renderH: 4, sourceW: 0, sourceH: 0,
  quality: 'balanced', frameDirty: false, frameTime: -1, imageReady: false,
  videoReady: false, isRecording: false, recordStarting: false, recorder: null, stream: null,
  recordStartedAt: 0, recordDuration: 0, recordedBlob: null, recordedName: '',
  pointer: [0.5, 0.5], touchForce: 0, touchTarget: 0,
  kinetic: 0, kineticTarget: 0, pointerTime: 0, pointerIsDown: false,
  activeURL: null, firstDraw: true, renderingError: false,
  historyReady: false, historyW: 0, historyH: 0,
  lastRenderTime: 0, sourceGeneration: 0
};

let gl, canvas, program, sourceTexture, buffer, sourceCanvas, sourceCtx, u;
let feedbackTextures = [], feedbackFramebuffer = null, feedbackReadIndex = 0;
let aPosition = -1, aUv = -1;
let lastTimestamp = performance.now();
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
    setStatus(`GPU INIT FAILED: ${error.message}`, true);
    console.error(error);
  }
  resizePreview();
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    state.renderingError = true;
    if (state.isRecording) stopRecording();
    setStatus('GPU CONTEXT LOST', true);
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
      setStatus('GPU RESTORED');
    } catch (error) { setStatus(`GPU RESTORE FAILED: ${error.message}`, true); }
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
  state.touchForce += (state.touchTarget - state.touchForce) * Math.min(1, dt * 11);
  state.kinetic += (state.kineticTarget - state.kinetic) * Math.min(1, dt * 7);
  if (!state.pointerIsDown) state.kineticTarget *= Math.exp(-dt*13);

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
    if (state.isRecording && (now - state.recordStartedAt) >= MAX_RECORD_SECONDS * 1000) {
      stopRecording();
    }
  } catch (error) {
    if (state.type === 'video') state.frameDirty = true;
    if (!state.renderingError) {
      setStatus(`RENDER FAILED: ${error.message}`, true);
      console.error(error);
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
  uniform float u_memory;
  uniform vec2 u_texel;
  uniform vec2 u_resolution;
  uniform vec2 u_pointer;
  uniform float u_touch;
  uniform float u_kinetic;
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
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 s = f*f*(3.0-2.0*f);
    return mix(mix(hash21(i),hash21(i+vec2(1.0,0.0)),s.x),
               mix(hash21(i+vec2(0.0,1.0)),hash21(i+vec2(1.0,1.0)),s.x),s.y);
  }
  float fbm(vec2 p) {
    float n = 0.0;
    float a = 0.5;
    for (int i=0; i<4; i++) {
      n += a*noise2(p);
      p = p*2.07 + vec2(12.3,5.4);
      a *= 0.5;
    }
    return n;
  }
  vec3 src(vec2 uv) {
    return texture2D(u_source,clamp(uv,vec2(0.001),vec2(0.999))).rgb;
  }
  vec3 past(vec2 uv) {
    return texture2D(u_history,clamp(uv,vec2(0.001),vec2(0.999))).rgb;
  }

  void main() {
    vec2 uv = v_uv;
    vec2 aspect = vec2(u_resolution.x/u_resolution.y,1.0);
    float d = u_depth;
    float e = u_erosion;
    float t = u_time * (0.58 + u_drift * 0.62);
    float kinetic = sat(u_kinetic);
    vec2 field = uv*vec2(5.7,9.1) + vec2(u_seed,u_seed*0.31);
    float n = fbm(field + vec2(t*0.19,-t*0.13));
    float medium = fbm(field*2.5 - vec2(t*0.22,-t*0.16));
    float micro = hash21(floor(uv*u_resolution*0.48) + u_seed*13.5);
    float dist = length((uv-u_pointer)*aspect);
    float probe = exp(-dist*dist/(0.018+d*0.012)) * u_touch;
    float gesture = probe*(0.34+kinetic*0.42);

    vec2 flow = vec2(noise2(field*1.35+t*0.28)-0.5,
                     noise2(field*1.28+12.8-t*0.25)-0.5);
    vec2 displaced = uv + flow*(0.0010+e*0.0075)*(0.22+u_drift*0.65);
    displaced += flow*gesture*(0.012 + kinetic*0.028);
    if(u_mode>3.5) {
      float row = floor(uv.y*118.0+t*1.1);
      float breakup = step(0.978-0.018*e,hash21(vec2(row,floor(t*0.4)+u_seed)));
      displaced.x += breakup*(noise2(vec2(row,t+u_seed))-0.5)*e*0.018;
    }
    displaced = clamp(displaced,vec2(0.001),vec2(0.999));
    vec3 c = src(displaced);
    float l = lum(c);
    vec2 stepUV = u_texel*(1.10+1.05*d);
    float gx = lum(src(displaced+vec2(stepUV.x,0.0))) - lum(src(displaced-vec2(stepUV.x,0.0)));
    float gy = lum(src(displaced+vec2(0.0,stepUV.y))) - lum(src(displaced-vec2(0.0,stepUV.y)));
    float edge = sat(length(vec2(gx,gy))*(2.6+3.6*d));
    float outline = smoothstep(0.16,0.44,edge);
    float organ = n*0.74+medium*0.26;
    vec3 color = c;

    if (u_mode<0.5) {
      float shear = noise2(uv*vec2(2.8,6.2)+vec2(t*0.05,u_seed*0.23));
      float fault = smoothstep(0.46,0.67,shear+outline*0.05);
      float stratum = l + (organ-0.5)*(0.11+0.21*e)
                    + (fault-0.5)*e*0.12 + (micro-0.5)*e*0.02;
      stratum += gesture*(0.08+0.08*e)*(0.5+fault*0.5);
      float a = smoothstep(0.18-0.04*d,0.44-0.04*d,stratum);
      float b = smoothstep(0.46-0.03*d,0.69-0.03*d,stratum);
      float top = smoothstep(0.66-0.03*d,0.84-0.02*d,stratum+medium*0.05);
      vec3 ink = vec3(0.038,0.031,0.070);
      vec3 purple = vec3(0.24,0.10,0.40);
      vec3 flesh = vec3(0.74,0.61,0.70);
      vec3 acid = vec3(0.47,0.50,0.12);
      color = mix(ink,purple,a);
      color = mix(color,flesh,b);
      float vein = top*(smoothstep(0.34,0.73,medium)*0.48+outline*0.18);
      color = mix(color,acid,sat(vein)*0.55);
      color = mix(color,vec3(0.02,0.02,0.03),outline*(0.38+0.08*d));
      color += (micro-0.5)*(0.030*e);
      color = mix(color, vec3(l), 0.08);
      color = mix(color, c, 0.12);
      if(u_historyMix>0.5) {
        vec3 remnant = past(uv+flow*(0.002+0.006*e));
        color = mix(color,remnant,(0.16+0.12*d)*u_memory);
      }
    } else if (u_mode<1.5) {
      vec3 neg = pow(sat3(1.0-c),vec3(0.92+0.10*d));
      color = mix(neg,vec3(0.90,0.92,0.95),0.06+e*0.08);
      float warmth = smoothstep(0.22,0.61,l)*(1.0-smoothstep(0.66,0.95,l));
      color = mix(color,vec3(0.46,0.35,0.38),warmth*(0.08+0.16*d));
      float exposureLevel = 0.40 + 0.12*noise2(vec2(t*0.08+u_seed,3.7));
      float latent = (1.0-smoothstep(0.055,0.16,abs(l-exposureLevel)));
      latent *= smoothstep(0.34,0.74,organ)*(0.12+0.20*e);
      color = mix(color,vec3(0.95,0.95,0.90),latent);
      vec2 fringe = vec2(gx,gy)*u_texel*(2.8+8.0*e);
      float cyanRim = outline*(0.16+0.20*e);
      color = mix(color,vec3(0.32,0.66,0.80),cyanRim);
      color.r += (src(displaced+fringe).r-c.r)*0.08*e;
      color.b += (src(displaced-fringe).b-c.b)*0.07*e;
      color = mix(color,vec3(0.33,0.30,0.42),(micro-0.53)*e*0.05);
      color = mix(color,c,0.10);
      color = mix(color,vec3(0.93,0.96,0.98),gesture*(0.10+0.08*d));
    } else if (u_mode<2.5) {
      float angle = t*0.15+u_seed*0.07;
      vec3 lightDirection = normalize(vec3(-0.62*cos(angle)-0.18,
                                            0.48*sin(angle*0.76+0.6)+0.20,0.76));
      vec3 normal = normalize(vec3(-gx*(3.2+d*6.2),-gy*(3.2+d*6.2),0.52+0.16*(1.0-d)));
      float light = sat(dot(normal,lightDirection)*0.55+0.36);
      float elevation = l+(organ-0.5)*0.09*e + gesture*(0.06+0.08*e);
      float bands = 8.0 + d*16.0;
      float contour = 1.0-smoothstep(0.018,0.060,abs(fract(elevation*bands)-0.5));
      vec3 chalk = mix(vec3(0.13,0.13,0.15),vec3(0.67,0.63,0.58),light);
      chalk = mix(chalk,vec3(0.88,0.84,0.78),smoothstep(0.50,0.86,elevation)*0.42);
      color = mix(chalk,vec3(0.07,0.07,0.08),contour*(0.14+0.22*e));
      color = mix(color,vec3(0.04,0.04,0.05),outline*0.18);
      color += (micro-0.5)*e*0.05;
      color = mix(color, c, 0.10);
    } else if (u_mode<3.5) {
      float liquid = l+(organ-0.52)*(0.24*e)-outline*0.09;
      liquid += (noise2(field*0.55 + vec2(t*0.05,-t*0.03))-0.5)*e*0.11;
      liquid -= gesture*(0.07+0.11*e);
      float stain = smoothstep(0.28-0.08*d,0.53,liquid);
      float crust = smoothstep(0.52,0.78,liquid+medium*0.08);
      vec3 black = vec3(0.032,0.031,0.040);
      vec3 lilac = vec3(0.36,0.24,0.54);
      vec3 pallid = vec3(0.80,0.75,0.78);
      color = mix(black,lilac,stain);
      color = mix(color,pallid,crust);
      float seep = smoothstep(0.58,0.82,organ+outline*0.14)*(1.0-smoothstep(0.86,1.0,l));
      color = mix(color,vec3(0.54,0.56,0.16),seep*(0.10+0.24*e));
      color *= (1.0-0.24*outline);
      color += (micro-0.5)*0.05*e;
      color = mix(color, c, 0.10);
      if(u_historyMix>0.5) {
        vec3 residue = past(uv+flow*(0.002+0.008*e));
        float pooling = (0.18+0.12*d)*u_memory*(0.90+0.10*outline);
        color = mix(color,residue,pooling);
      }
    } else {
      vec2 shift = vec2(0.0018+0.010*e,0.0012+0.006*e);
      shift *= vec2(sin(t*0.25+u_seed)*0.35+0.65,cos(t*0.23+u_seed)*0.35+0.65);
      vec3 right = src(displaced+shift+flow*0.006);
      vec3 left = src(displaced-shift*1.05);
      vec3 ghost = vec3(right.r,c.g*0.72+right.b*0.14+left.g*0.14,left.b);
      float corridor = fbm(uv*vec2(16.0,6.5)+vec2(-t*0.20,u_seed));
      color = mix(c,ghost,0.28+0.18*e);
      color = mix(color,vec3(0.055,0.06,0.078),0.09+0.09*d);
      color += vec3(0.13,0.04,0.19)*outline*(0.06+0.16*e);
      color += vec3(0.006,0.08,0.10)*(corridor-0.50)*e*0.18;
      color += (micro-0.5)*e*0.025;
      color += vec3(0.12,0.05,0.15)*gesture*(0.10+0.16*e);
      if(u_historyMix>0.5) {
        vec2 pastUv = uv+flow*(0.0015+e*0.006)+vec2(sin(t*0.42),cos(t*0.31))*0.0012;
        vec3 residual = past(pastUv);
        color = mix(color,residual,(0.28+0.10*d)*u_memory);
      }
      color = mix(color, c, 0.18);
    }

    float cl = lum(color);
    float srcLift = 0.18 + 0.72*l;
    color = mix(color, color * (srcLift / max(0.10, cl)), 0.14);
    color = mix(vec3(cl), color, 0.92);
    color = color * 0.96 + vec3(0.018);
    gl_FragColor = vec4(sat3(color),1.0);
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
  for (const name of ['u_source','u_history','u_historyMix','u_memory',
      'u_texel','u_resolution','u_pointer','u_touch','u_kinetic',
      'u_time','u_seed','u_mode','u_depth','u_erosion','u_drift']) {
    u[name] = gl.getUniformLocation(program,name);
  }
  gl.uniform1i(u.u_source,0);
  gl.uniform1i(u.u_history,1);
  sourceCanvas = document.createElement('canvas');
  sourceCtx = sourceCanvas.getContext('2d',{alpha:false});
  if (!sourceCtx) throw new Error('2D SOURCE CANVAS UNAVAILABLE');
}
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
  gl.uniform1f(u.u_historyMix, state.historyReady && (state.mode===0 || state.mode===3 || state.mode===4) ? 1 : 0);
  gl.uniform1f(u.u_memory, state.memoryFactor || 1);
  gl.uniform2f(u.u_texel,1/state.sourceW,1/state.sourceH);
  gl.uniform2f(u.u_resolution,w,h);
  gl.uniform2f(u.u_pointer,state.pointer[0],state.pointer[1]);
  gl.uniform1f(u.u_touch,state.touchForce);
  gl.uniform1f(u.u_kinetic,state.kinetic);
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
  // Frame-rate independent memory retention; no CPU readback.
  const elapsed = state.lastRenderTime > 0 ? Math.max(1/60, Math.min(0.15, now-state.lastRenderTime)) : 1/24;
  state.lastRenderTime = now;
  state.memoryFactor = Math.pow(0.98, elapsed*24);
  drawPass(null, canvas.width, canvas.height, now);
  if ((state.mode===0 || state.mode===3 || state.mode===4) && updateHistory) {
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
    state.renderW=w;state.renderH=h;
    if (clearHistory) initFeedback();
  } else if(clearHistory) resetFeedback();
  resizePreview();
}
function setSourceDimensions(w,h) {
  state.originalW=w;state.originalH=h;
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
  if (!PERFORMANCE[q] || state.isRecording || state.recordStarting) return;
  state.quality=q;
  frameRate(PERFORMANCE[q].fps);
  if(state.imageReady){
    const [w,h]=previewSize();
    if(state.type==='video')changeVideoSourceSize(w,h);
    setRenderSize(w,h,true);
    $('dimensionsTag').textContent=`${w} × ${h} · GPU`;
    if(state.type==='photo')state.frameDirty=true;
  }
  setStatus(`QUALITY / ${q.toUpperCase()}`);
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
  state.sourceGeneration++;
  state.type='none'; state.element=null; state.frameDirty=false; state.imageReady=false;
  resetFeedback();
  state.videoReady=false; state.renderingError=false;
  state.frameTime=-1; state.touchForce=0; state.touchTarget=0;
  state.kinetic=0; state.kineticTarget=0; state.pointerIsDown=false; state.lastRenderTime=0;
  clearExport();
}
async function openFile(file) {
  if (!file || state.isRecording || state.recordStarting) return;
  if (!gl || !sourceCtx || !program) {setStatus('WEBGL UNAVAILABLE',true);return;}
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(heic|heif|png|jpeg|jpg|webp)$/i.test(file.name);
  if (!isVideo && !isImage) {setStatus('UNSUPPORTED FILE',true);return;}
  clearPreviousSource();
  state.type=isVideo?'video':'photo'; state.fileName=file.name;
  state.objectUrl=URL.createObjectURL(file);
  $('assetName').textContent=file.name;
  $('sourceTag').textContent=isVideo?'VIDEO INPUT':'STILL INPUT';
  $('emptyState').hidden=true;
  $('emptyState').style.display='none';
  $('stage').classList.add('has-source');
  $('saveButton').disabled=true;
  $('playButton').disabled=true;
  $('recordButton').disabled=true;
  setStatus('LOADING');
  try {
    if (isVideo) {
      const video=$('sourceVideo');
      state.element=video;
      video.loop=true; video.muted=true; video.playsInline=true;
      video.src=state.objectUrl;
      video.load();
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('VIDEO LOAD TIMEOUT')),18000);
        video.addEventListener('loadedmetadata',()=>{clearTimeout(timeout);resolve();},{once:true});
        video.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('VIDEO DECODE FAILED'));},{once:true});
      });
      setSourceDimensions(video.videoWidth,video.videoHeight);
      state.imageReady=true; state.videoReady=true; state.frameDirty=true;
      video.ontimeupdate=()=>{state.frameDirty=true;};
      if (typeof video.requestVideoFrameCallback === 'function') {
        const generation=state.sourceGeneration;
        const onVideoFrame=()=>{
          if(state.sourceGeneration!==generation || state.type!=='video')return;
          state.frameDirty=true;
          video.requestVideoFrameCallback(onVideoFrame);
        };
        video.requestVideoFrameCallback(onVideoFrame);
      }
      video.onended=()=>{if(state.isRecording)stopRecording();};
      $('timecode').textContent=secondsToClock(0);
      $('playButton').disabled=false;
      $('recordButton').disabled=!canRecord();
      $('saveButton').disabled=false;
      $('playLabel').textContent='PAUSE'; $('playIcon').textContent='Ⅱ';
      let started = true;
      try {await video.play();} catch {
        started = false;
        $('playLabel').textContent='PLAY'; $('playIcon').textContent='▶';
      }
      setStatus(started ? 'VIDEO READY' : 'READY / PRESS PLAY');
    } else {
      const img=new Image();
      state.element=img;
      await new Promise((resolve,reject)=>{
        img.onload=resolve;
        img.onerror=()=>reject(new Error('IMAGE DECODE FAILED'));
        img.src=state.objectUrl;
      });
      setSourceDimensions(img.naturalWidth,img.naturalHeight);
      state.imageReady=true; state.frameDirty=true;
      $('timecode').textContent='STILL';
      $('saveButton').disabled=false;
      $('recordButton').disabled=!canRecord();
      setStatus(canRecord() ? 'IMAGE READY' : 'IMAGE READY · RECORD UNSUPPORTED');
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
  if (state.type!=='video'||!state.videoReady || state.recordStarting) return;
  const v=state.element;
  if (state.isRecording) {stopRecording();return;}
  if (v.paused) {
    v.play().then(()=>{$('playLabel').textContent='PAUSE';$('playIcon').textContent='Ⅱ';})
      .catch(err=>setStatus(`PLAYBACK FAILED: ${err.message}`,true));
  } else {
    v.pause();
    $('playLabel').textContent='PLAY';$('playIcon').textContent='▶';
  }
}
function toBlobAsync(c,type,quality) {
  return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('IMAGE ENCODE FAILED')),type,quality));
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
  if (!state.imageReady || state.isRecording || state.recordStarting) return;
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
      setRenderSize(...originalSize);
      await shareOrSave(blob,name,true);
      setStatus(`IMAGE EXPORTED · ${exportW} × ${exportH}`);
    } finally {
      if(canvas.width!==originalSize[0] || canvas.height!==originalSize[1]) setRenderSize(...originalSize);
    }
  } catch(error) {setStatus(`EXPORT FAILED: ${error.message}`,true);console.error(error);}
}
function canRecord() {
  return !!canvas && typeof canvas.captureStream === 'function' &&
    typeof MediaRecorder !== 'undefined';
}
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const apple = /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent) &&
    !/Chrome|CriOS|Edg/i.test(navigator.userAgent);
  const webm = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  const mp4 = ['video/mp4;codecs=avc1.42E01E', 'video/mp4'];
  const ordered = apple ? [...mp4, ...webm] : [...webm, ...mp4];
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return ordered.find(mime => MediaRecorder.isTypeSupported(mime)) || '';
}
function syncRecordControls(busy = false) {
  const locked = busy || state.isRecording || state.recordStarting;
  $('recordButton').disabled = busy || !state.imageReady || !canRecord();
  $('importButton').disabled = locked;
  $('playButton').disabled = locked || state.type !== 'video' || !state.videoReady;
  $('saveButton').disabled = locked || !state.imageReady;
  $('renderQuality').disabled = locked;
}
async function startRecording() {
  if (!state.imageReady || state.isRecording || state.recordStarting) return;
  if (!canRecord()) {
    setStatus('RECORD UNSUPPORTED IN THIS BROWSER', true);
    return;
  }
  state.recordStarting = true;
  syncRecordControls(true);
  clearExport();
  let stream = null;
  let started = false;
  const videoInput = state.type === 'video';
  const video = videoInput ? state.element : null;
  try {
    if (videoInput) {
      if (!state.videoReady) throw new Error('VIDEO NOT READY');
      video.pause();
      video.loop = false;
      if (video.currentTime > 0.01) {
        video.currentTime = 0;
        if (video.seeking) await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('VIDEO SEEK TIMEOUT')), 4000);
          video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once:true });
        });
      }
    }
    const [recordW, recordH] = sizeForLimit(
      state.originalW, state.originalH, PERFORMANCE[state.quality].video
    );
    if (videoInput) changeVideoSourceSize(recordW, recordH);
    setRenderSize(recordW, recordH, true);
    sourceCtx.drawImage(state.element, 0, 0, state.sourceW, state.sourceH);
    uploadSource();
    state.frameDirty = false;
    state.frameTime = videoInput ? video.currentTime : -1;
    renderFrame(performance.now() * .001);

    stream = canvas.captureStream(PERFORMANCE[state.quality].fps);
    const mime = pickMimeType();
    const options = {
      videoBitsPerSecond: Math.max(1800000, Math.min(6000000, recordW * recordH * 4.5))
    };
    if (mime) options.mimeType = mime;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch (codecError) {
      if (!mime) throw codecError;
      recorder = new MediaRecorder(stream, { videoBitsPerSecond: options.videoBitsPerSecond });
    }
    const chunks = [];
    state.stream = stream;
    state.recorder = recorder;
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = event => {
      setStatus(`RECORD FAILED: ${event.error?.message || 'UNKNOWN'}`, true);
      stopRecording();
    };
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      const elapsed = Math.min(MAX_RECORD_SECONDS,
        Math.max(0, (performance.now() - state.recordStartedAt) / 1000));
      state.recordDuration = elapsed;
      state.isRecording = false;
      state.recordStarting = false;
      state.recorder = null;
      state.stream = null;
      document.body.classList.remove('is-recording');
      $('recordLabel').textContent = 'RECORD';
      $('recState').textContent = '';
      if (videoInput && state.type === 'video') {
        video.loop = true;
        $('playLabel').textContent = 'PLAY';
        $('playIcon').textContent = '▶';
        const [pw, ph] = previewSize();
        changeVideoSourceSize(pw, ph);
      }
      if (state.imageReady) {
        const [pw, ph] = previewSize();
        setRenderSize(pw, ph, true);
        state.frameDirty = true;
        $('dimensionsTag').textContent = `${pw} × ${ph} · GPU`;
      }
      syncRecordControls(false);
      if (!chunks.length) {
        setStatus('NO VIDEO DATA', true);
        return;
      }
      const actualMime = recorder.mimeType || mime || 'video/webm';
      const extension = /mp4/i.test(actualMime) ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: actualMime });
      state.recordedBlob = blob;
      state.recordedName = `hidden_${safeBaseName(state.fileName)}_${Date.now()}.${extension}`;
      $('exportDetails').textContent = `${secondsToClock(elapsed)} / ${recordW} × ${recordH} / ${extension.toUpperCase()} / SILENT / ${(blob.size / 1048576).toFixed(1)} MB`;
      $('exportPanel').hidden = false;
      try {
        const file = new File([blob], state.recordedName, { type: blob.type });
        $('shareVideo').disabled = !(navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
      } catch (_) { $('shareVideo').disabled = true; }
      setStatus('VIDEO READY');
    };
    recorder.start(300);
    state.recordStartedAt = performance.now();
    state.isRecording = true;
    started = true;
    document.body.classList.add('is-recording');
    $('recordLabel').textContent = 'STOP';
    $('recState').textContent = '● REC 00:00';
    syncRecordControls(false);
    if (videoInput) {
      try {
        await video.play();
        $('playLabel').textContent = 'PAUSE';
        $('playIcon').textContent = 'Ⅱ';
      } catch (playError) {
        stopRecording();
        throw new Error(`VIDEO PLAYBACK FAILED: ${playError.message}`);
      }
    }
    setStatus(videoInput ? 'RECORDING VIDEO · 45S MAX' : 'RECORDING STILL · 45S MAX');
  } catch (error) {
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.onstop = null;
      state.recorder.stop();
    }
    if (stream) stream.getTracks().forEach(track => track.stop());
    state.isRecording = false;
    state.recorder = null;
    state.stream = null;
    state.recordStarting = false;
    document.body.classList.remove('is-recording');
    $('recordLabel').textContent = 'RECORD';
    $('recState').textContent = '';
    if (state.imageReady) {
      if (videoInput && state.type === 'video') {
        video.loop = true;
        $('playLabel').textContent = 'PLAY';
        $('playIcon').textContent = '▶';
        const [pw, ph] = previewSize();
        changeVideoSourceSize(pw, ph);
      }
      const [pw, ph] = previewSize();
      setRenderSize(pw, ph, true);
      state.frameDirty = true;
    }
    syncRecordControls(false);
    setStatus(`RECORD FAILED: ${error.message}`, true);
    console.error(error);
  } finally {
    if (!started) syncRecordControls(false);
  }
}
function stopRecording() {
  if (!state.isRecording || !state.recorder) return;
  const recorder = state.recorder;
  state.isRecording = false;
  $('recordButton').disabled = true;
  if (state.type === 'video' && state.element) state.element.pause();
  if (recorder.state !== 'inactive') recorder.stop();
}
function clearExport() {state.recordedBlob=null;state.recordedName='';$('exportPanel').hidden=true;}
function setMode(mode) {
  if (state.mode!==mode) resetFeedback();
  state.mode=mode;
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
    state.seed=Math.random()*120+1;resetFeedback();state.lastRenderTime=0;setStatus('RESEEDED');
  });
  $('renderQuality').addEventListener('change',e=>changeQuality(e.target.value));
  $('importButton').addEventListener('click',()=>{if(!state.isRecording && !state.recordStarting)$('fileInput').click();});
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
    state.pointerIsDown=true;state.pointerTime=0;updateTouch(event);state.touchTarget=1;
    if(event.target===canvas) canvas.setPointerCapture(event.pointerId);
  });
  $('canvas-host').addEventListener('pointermove',event=>{
    if(state.pointerIsDown)updateTouch(event);
  });
  ['pointerup','pointercancel','pointerleave'].forEach(type=>{
    $('canvas-host').addEventListener(type,()=>{state.touchTarget=0;state.pointerIsDown=false;state.kineticTarget=0;});
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
  $('depthValue').textContent=String(Math.round(state.depth*100)).padStart(2,'0');
  $('erosionValue').textContent=String(Math.round(state.erosion*100)).padStart(2,'0');
  $('driftValue').textContent=String(Math.round(state.drift*100)).padStart(2,'0');
  $('depth').value=Math.round(state.depth*100);
  $('erosion').value=Math.round(state.erosion*100);
  $('drift').value=Math.round(state.drift*100);
  setInterval(()=>{
    if(state.isRecording){
      const elapsed=Math.min(MAX_RECORD_SECONDS,(performance.now()-state.recordStartedAt)/1000);
      $('recState').textContent=`● REC ${secondsToClock(elapsed)}`;
      if (elapsed >= MAX_RECORD_SECONDS) stopRecording();
    }
  },250);
}
function updateTouch(event) {
  const rect=canvas.getBoundingClientRect();
  if (rect.width<=0 || rect.height<=0) return;
  const point=[
    Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),
    Math.max(0,Math.min(1,1-(event.clientY-rect.top)/rect.height))
  ];
  const now=performance.now();
  if(state.pointerTime>0) {
    const dt=Math.max(0.012,(now-state.pointerTime)/1000);
    const travel=Math.hypot((point[0]-state.pointer[0])*rect.width/rect.height,point[1]-state.pointer[1]);
    state.kineticTarget=Math.min(1,travel/dt*0.32);
  }
  state.pointer=point;
  state.pointerTime=now;
}

document.addEventListener('DOMContentLoaded',()=>{
  bindEvents();
  if ('serviceWorker' in navigator && location.protocol==='https:') {
    navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).catch(()=>{});
  }
});
