'use strict';

let gl;
let surface;
let shProgram;
let spaceball;
let uSegments = 30;
let vSegments = 30;
let stereoCamera;
let video;

let eyeSeparation = 2;
let fov = 45;
let nearClip = 5;
let convergence = 100;
const farClip = 100;

let surfaceAlpha = 0.7;

let socket;
let sensorData = { alpha: 0, beta: 0, gamma: 0 };
let useSensor = false;
let sensorAngleOffset = null;

let audioCtx, audioBuffer, audioSource, panner, filterNode;
let audioIsPlaying = false;
let audioAngle = 0;     
let audioDistance = 6.0; 
let audioFilterEnabled = true;
let soundSphere = { x: 0, y: 0, z: 0, radius: 0.42 };

function deg2rad(angle) { return angle * Math.PI / 180; }
function computeAlpha(convergence) {
    const minC = 10, maxC = 500, minAlpha = 0.2, maxAlpha = 0.7;
    const c = Math.max(minC, Math.min(maxC, convergence));
    const t = (c - minC) / (maxC - minC);
    return minAlpha + (maxAlpha - minAlpha) * t;
}

function StereoCamera(convergence, eyeSeparation, aspectRatio, fov, nearClip, farClip) {
    this.mConvergence = convergence;
    this.mEyeSeparation = eyeSeparation;
    this.mAspectRatio = aspectRatio;
    this.mFOV = deg2rad(fov);
    this.mNearClippingDistance = nearClip;
    this.mFarClippingDistance = farClip;
    const minEffectiveConvergence = 50;
    this.effectiveConvergence = Math.max(this.mConvergence, minEffectiveConvergence);

    this.getFrustum = function(eyeSign) {
        const top = this.mNearClippingDistance * Math.tan(this.mFOV / 2);
        const bottom = -top;
        const a = this.mAspectRatio * top;
        const shift = (this.mEyeSeparation / 2.0) * eyeSign;
        const frustumShift = shift * this.mNearClippingDistance / this.effectiveConvergence;
        const left = -a + frustumShift;
        const right = a + frustumShift;
        return [left, right, bottom, top];
    };

    this.ApplyFrustum = function(modelViewMatrix, eyeSign) {
        const [left, right, bottom, top] = this.getFrustum(eyeSign);
        const projection = m4.frustum(left, right, bottom, top, this.mNearClippingDistance, this.mFarClippingDistance);
        const mv = m4.translate(modelViewMatrix, (this.mEyeSeparation / 2.0) * eyeSign, 0, 0);
        return m4.multiply(projection, mv);
    };
}

function Model(name) {
    this.name = name;
    this.triVertexBuffer = gl.createBuffer();
    this.triIndexBuffer = gl.createBuffer();
    this.triIndexCount = 0;
    this.uLineBuffer = gl.createBuffer();
    this.uLineCount = 0;
    this.vLineBuffer = gl.createBuffer();
    this.vLineCount = 0;

    this.BufferData = function(vertices, indices, uLines, vLines) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.triVertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
        this.triIndexCount = indices.length;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.uLineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uLines), gl.STATIC_DRAW);
        this.uLineCount = uLines.length / 3;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vLineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vLines), gl.STATIC_DRAW);
        this.vLineCount = vLines.length / 3;
    };

    this.DrawTriangles = function() {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.triVertexBuffer);
        gl.vertexAttribPointer(shProgram.iAttribVertex, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(shProgram.iAttribVertex);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triIndexBuffer);
        gl.drawElements(gl.TRIANGLES, this.triIndexCount, gl.UNSIGNED_SHORT, 0);
    };
    this.DrawULines = function() {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.uLineBuffer);
        gl.vertexAttribPointer(shProgram.iAttribVertex, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(shProgram.iAttribVertex);
        gl.drawArrays(gl.LINES, 0, this.uLineCount * 2);
    };
    this.DrawVLines = function() {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vLineBuffer);
        gl.vertexAttribPointer(shProgram.iAttribVertex, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(shProgram.iAttribVertex);
        gl.drawArrays(gl.LINES, 0, this.vLineCount * 2);
    };
}

function ShaderProgram(name, program) {
    this.name = name;
    this.prog = program;
    this.iAttribVertex = -1;
    this.iModelViewProjectionMatrix = -1;
    this.iColor = -1;
    this.Use = function() { gl.useProgram(this.prog);}
}

function drawSphere(mvpMatrix, sx, sy, sz, radius, color) {
    const latBands = 12, longBands = 12;
    let vtx = [];
    for (let lat=0; lat<=latBands; lat++) {
        let theta = lat * Math.PI/latBands;
        let sinT = Math.sin(theta), cosT = Math.cos(theta);
        for (let lon=0; lon<=longBands; lon++) {
            let phi = lon*2*Math.PI/longBands;
            let sinP = Math.sin(phi), cosP = Math.cos(phi);
            let x = sx + radius*cosP*sinT;
            let y = sy + radius*sinP*sinT;
            let z = sz + radius*cosT;
            vtx.push(x, y, z);
        }
    }
    gl.uniform4fv(shProgram.iColor, color);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vtx), gl.STREAM_DRAW);
    gl.vertexAttribPointer(shProgram.iAttribVertex, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(shProgram.iAttribVertex);
    gl.drawArrays(gl.POINTS, 0, vtx.length/3);
}

function drawSurface() {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4fv(shProgram.iColor, [1.0, 1.0, 1.0, surfaceAlpha]);
    surface.DrawTriangles();
    gl.uniform4fv(shProgram.iColor, [0.0, 0.0, 0.0, 1.0]);
    surface.DrawULines();
    surface.DrawVLines();
    gl.disable(gl.BLEND);
}

function drawSoundSourceSphere(mvp) {
    drawSphere(mvp, soundSphere.x, soundSphere.y, soundSphere.z, soundSphere.radius, [1,0,1,0.7]);
}

function CreateSurfaceData() {
    let vertices = [], indices = [], uLines = [], vLines = [];
    const scale = 0.5, a = 1.5*scale, b = 3.0*scale, c = 2.0*scale, d = 2.0*scale;
    function f(v) { return (a*b) / Math.sqrt((a**2)*Math.sin(v)**2 + (b**2)*Math.cos(v)**2);}
    for (let i = 0; i <= uSegments; i++) {
        const t = (i / uSegments) * 2 * Math.PI;
        for (let j = 0; j <= vSegments; j++) {
            const v = (j / vSegments) * 2 * Math.PI;
            const fv = f(v), cosT = Math.cos(t), sinT = Math.sin(t), cosV = Math.cos(v), sinV = Math.sin(v);
            const x = 0.5 * (fv * (1 + cosT) + (d ** 2 - c ** 2) * (1 - cosT) / fv) * cosV;
            const y = 0.5 * (fv * (1 + cosT) + (d ** 2 - c ** 2) * (1 - cosT) / fv) * sinV;
            const z = 0.5 * (fv - (d ** 2 - c ** 2) / fv) * sinT;
            vertices.push(x, y, z);
        }
    }
    for (let i = 0; i < uSegments; i++) {
        for (let j = 0; j < vSegments; j++) {
            const p0 = i * (vSegments + 1) + j,
                p1 = p0 + 1,
                p2 = (i + 1) * (vSegments + 1) + j,
                p3 = p2 + 1;
            indices.push(p0, p1, p2);
            indices.push(p1, p3, p2);
        }
    }
    for (let j = 0; j <= vSegments; j++) {
        for (let i = 0; i < uSegments; i++) {
            const p0 = i * (vSegments + 1) + j,
                p1 = (i + 1) * (vSegments + 1) + j;
            uLines.push(vertices[3*p0], vertices[3*p0+1], vertices[3*p0+2], vertices[3*p1], vertices[3*p1+1], vertices[3*p1+2]);
        }
    }
    for (let i = 0; i <= uSegments; i++) {
        for (let j = 0; j < vSegments; j++) {
            const p0 = i * (vSegments + 1) + j,
                p1 = i * (vSegments + 1) + (j + 1);
            vLines.push(vertices[3*p0], vertices[3*p0+1], vertices[3*p0+2], vertices[3*p1], vertices[3*p1+1], vertices[3*p1+2]);
        }
    }
    return { vertices, indices, uLines, vLines };
}

function initGL() {
    let prog = createProgram(gl, vertexShaderSource, fragmentShaderSource);
    shProgram = new ShaderProgram('Basic', prog);
    shProgram.Use();
    shProgram.iAttribVertex = gl.getAttribLocation(prog, "vertex");
    shProgram.iModelViewProjectionMatrix = gl.getUniformLocation(prog, "ModelViewProjectionMatrix");
    shProgram.iColor = gl.getUniformLocation(prog, "color");
    surface = new Model('Surface');
    const { vertices, indices, uLines, vLines } = CreateSurfaceData();
    surface.BufferData(vertices, indices, uLines, vLines);
    gl.enable(gl.DEPTH_TEST);
}

function createProgram(gl, vShader, fShader) {
    let vsh = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vsh, vShader); gl.compileShader(vsh);
    if (!gl.getShaderParameter(vsh, gl.COMPILE_STATUS)) throw new Error("Error in vertex shader:  " + gl.getShaderInfoLog(vsh));
    let fsh = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fsh, fShader); gl.compileShader(fsh);
    if (!gl.getShaderParameter(fsh, gl.COMPILE_STATUS)) throw new Error("Error in fragment shader:  " + gl.getShaderInfoLog(fsh));
    let prog = gl.createProgram();
    gl.attachShader(prog, vsh); gl.attachShader(prog, fsh); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("Link error in program:  " + gl.getProgramInfoLog(prog));
    return prog;
}

function updateParameter(param, value, displayElementId) {
    switch(param) {
        case 'eyeSeparation': eyeSeparation = parseFloat(value); break;
        case 'fov': fov = parseFloat(value); break;
        case 'nearClip': nearClip = parseFloat(value); break;
        case 'convergence': convergence = parseFloat(value); surfaceAlpha = computeAlpha(convergence); break;
        case 'uGranularity': uSegments = parseInt(value, 10); break;
        case 'vGranularity': vSegments = parseInt(value, 10); break;
    }
    document.getElementById(displayElementId).textContent = value;
    if (param === 'uGranularity' || param === 'vGranularity') {
        const { vertices, indices, uLines, vLines } = CreateSurfaceData();
        surface.BufferData(vertices, indices, uLines, vLines);
    }
    if (param === 'convergence') surfaceAlpha = computeAlpha(convergence);
    draw();
}

function connectWebSocket() {
    const serverAddress = prompt(
        "Enter Sensor Server address (e.g., ws://192.168.x.x:8080/sensor/connect?type=android.sensor.orientation):",
        "ws://192.168.0.100:8080/sensor/connect?type=android.sensor.orientation"
    );
    if (!serverAddress) return;
    socket = new WebSocket(serverAddress);
    socket.onopen = function() {
        useSensor = true;
        document.getElementById('sensor-status').textContent = "Connected";
        document.getElementById('sensor-status').style.color = "green";
        sensorAngleOffset = null;
    };
    socket.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            if (data.values && data.values.length >= 3) {
                sensorData.alpha = data.values[0];
                sensorData.beta = data.values[1];
                sensorData.gamma = data.values[2];
                if (sensorAngleOffset === null) {
                    sensorAngleOffset = sensorData.alpha;
                }
                updateSoundSphereBySensor();
            }
            draw();
        } catch (e) { console.error("Error parsing sensor data:", e, event.data);}
    };
    socket.onclose = function() {
        useSensor = false;
        document.getElementById('sensor-status').textContent = "Disconnected";
        document.getElementById('sensor-status').style.color = "red";
    };
    socket.onerror = function(error) {
        useSensor = false;
        document.getElementById('sensor-status').textContent = "Error";
        document.getElementById('sensor-status').style.color = "red";
    };
}

function updateSoundSphereBySensor() {
    let relativeAlpha = (sensorData.alpha - sensorAngleOffset);
    relativeAlpha = ((relativeAlpha % 360) + 360) % 360;
    audioAngle = relativeAlpha;
    updateSoundSourcePosition();
    document.getElementById('audioDistanceValue').textContent = audioDistance.toFixed(1);
}

function updateSoundSourcePosition() {
    let angleRad = deg2rad(audioAngle);
    let x = audioDistance * Math.cos(angleRad);
    let z = audioDistance * Math.sin(angleRad);
    let y = 0;
    if (panner) {
        if ("positionX" in panner) {
            panner.positionX.value = x;
            panner.positionY.value = y;
            panner.positionZ.value = z;
        } else {
            panner.setPosition(x, y, z);
        }
    }
    soundSphere.x = x; soundSphere.y = y; soundSphere.z = z;
}

function setupWebcam() {
    video = document.getElementById('webcam-video');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: true })
            .then(function(stream) { video.srcObject = stream; video.play(); })
            .catch(function() {
                video.style.display = 'none';
                document.getElementById('webglcanvas').style.backgroundColor = 'black';
            });
    }
}

function handleResize() {
    const canvas = document.getElementById('webglcanvas');
    const container = document.getElementById('webgl-container');
    canvas.width = container.clientWidth; canvas.height = container.clientHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    draw();
}

function animate() {
    draw();
    requestAnimationFrame(animate);
}

function init() {
    let canvas;
    try {
        canvas = document.getElementById("webglcanvas");
        gl = canvas.getContext("webgl", { alpha: true });
        if (!gl) throw "Browser does not support WebGL";
    } catch (e) {
        document.getElementById("webgl-container").innerHTML = "<p>Sorry, could not get a WebGL graphics context.</p>";
        return;
    }
    try { initGL(); }
    catch (e) {
        document.getElementById("webgl-container").innerHTML = "<p>Sorry, could not initialize the WebGL graphics context: " + e + "</p>";
        return;
    }
    spaceball = new TrackballRotator(canvas, draw, 0);
    handleResize();
    window.addEventListener('resize', handleResize);
    document.getElementById("eyeSeparation").addEventListener("input", function() { updateParameter('eyeSeparation', this.value, 'eyeSeparationValue');});
    document.getElementById("fov").addEventListener("input", function() { updateParameter('fov', this.value, 'fovValue');});
    document.getElementById("nearClip").addEventListener("input", function() { updateParameter('nearClip', this.value, 'nearClipValue');});
    document.getElementById("convergence").addEventListener("input", function() { updateParameter('convergence', this.value, 'convergenceValue');});
    document.getElementById("uGranularity").addEventListener("input", function() { updateParameter('uGranularity', this.value, 'uGranularityValue');});
    document.getElementById("vGranularity").addEventListener("input", function() { updateParameter('vGranularity', this.value, 'vGranularityValue');});
    document.getElementById("connectSensor").addEventListener("click", connectWebSocket);
    setupWebcam();
    setupAudioControls();
    animate();
}

function setupAudioControls() {
    document.getElementById('audioFile').addEventListener('change', handleAudioFile, false);
    document.getElementById('audioPlay').addEventListener('click', toggleAudioPlayback, false);
    document.getElementById('audioDistance').addEventListener('input', function() {
        audioDistance = parseFloat(this.value);
        document.getElementById('audioDistanceValue').textContent = audioDistance.toFixed(1);
        updateSoundSourcePosition();
    });
    document.getElementById('audioFilter').addEventListener('change', function() {
        audioFilterEnabled = this.checked;
        updateAudioFilter();
    });
    document.getElementById('audioDistanceValue').textContent = audioDistance.toFixed(1);
}

function handleAudioFile(evt) {
    let file = evt.target.files[0];
    if (!file) return;
    let reader = new FileReader();
    reader.onload = function(e) {
        let arrayBuffer = e.target.result;
        if (!audioCtx) {
            try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch(e) { alert('Web Audio API not supported'); return; }
        }
        audioCtx.decodeAudioData(arrayBuffer, function(buffer) {
            audioBuffer = buffer;
            resetAudioPlayback();
        }, function(err) {
            alert('Could not decode audio: ' + err);
        });
    };
    reader.readAsArrayBuffer(file);
}

function resetAudioPlayback() {
    stopAudio();
    audioIsPlaying = false;
    document.getElementById('audioPlay').textContent = "Play";
}

function toggleAudioPlayback() {
    if (!audioBuffer) return;
    if (!audioIsPlaying) {
        playAudio();
        document.getElementById('audioPlay').textContent = "Pause";
    } else {
        stopAudio();
        document.getElementById('audioPlay').textContent = "Play";
    }
}

function playAudio() {
    if (!audioBuffer || !audioCtx) return;
    stopAudio();
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = audioBuffer;
    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = "lowpass";
    filterNode.frequency.value = 1200;
    filterNode.Q.value = 1.0;
    panner = audioCtx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.0;
    panner.maxDistance = 100.0;
    panner.rolloffFactor = 1.0;
    updateSoundSourcePosition();
    if (audioFilterEnabled) {
        audioSource.connect(filterNode);
        filterNode.connect(panner);
    } else {
        audioSource.connect(panner);
    }
    panner.connect(audioCtx.destination);
    audioSource.loop = true;
    audioSource.start();
    audioIsPlaying = true;
}

function stopAudio() {
    if (audioSource) {
        try { audioSource.stop(); } catch(e) {}
        audioSource.disconnect(); audioSource = null;
    }
    if (panner) { panner.disconnect(); panner = null;}
    if (filterNode) { filterNode.disconnect(); filterNode = null;}
    audioIsPlaying = false;
}

function updateAudioFilter() {
    if (!audioIsPlaying || !audioSource || !panner) return;
    let wasPlaying = audioIsPlaying;
    stopAudio();
    if (wasPlaying) playAudio();
}

function draw() {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const aspectRatio = gl.canvas.clientWidth / gl.canvas.clientHeight;
    stereoCamera = new StereoCamera(convergence, eyeSeparation, aspectRatio, fov, nearClip, farClip);
    let modelView = spaceball.getViewMatrix();
    let rotateToPointZero = m4.axisRotation([0.707, 0.707, 0], 0.7);
    let translateToPointZero = m4.translation(0, 0, -10);
    modelView = m4.multiply(rotateToPointZero, modelView);
    modelView = m4.multiply(translateToPointZero, modelView);
    gl.colorMask(true, false, false, false);
    let leftMVP = stereoCamera.ApplyFrustum(modelView, -1);
    gl.uniformMatrix4fv(shProgram.iModelViewProjectionMatrix, false, leftMVP);
    drawSurface();
    drawSoundSourceSphere(leftMVP);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, true, true, false);
    let rightMVP = stereoCamera.ApplyFrustum(modelView, +1);
    gl.uniformMatrix4fv(shProgram.iModelViewProjectionMatrix, false, rightMVP);
    drawSurface();
    drawSoundSourceSphere(rightMVP);
    gl.colorMask(true, true, true, true);
}