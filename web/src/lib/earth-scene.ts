import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { OrbitFrame } from './earth-orbit';

export type EarthView = 'follow' | 'down' | 'globe' | 'explore';
const vec = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]);

/** Two depth ranges: kilometre-scale Earth and metre-scale spacecraft. No giant ISS. */
export class EarthScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(48, 1, .02, 5);
  readonly controls: OrbitControls;
  private earthCamera = new THREE.PerspectiveCamera(48, 1, 1, 40_000);
  private world = new THREE.Scene();
  private near = new THREE.Scene();
  private craft = new THREE.Group();
  private sun = new THREE.DirectionalLight(0xffffff, 3);
  private earthSun = new THREE.DirectionalLight(0xffffff, 2.6);
  private texture: THREE.Texture | null = null;
  private disposed = false;
  private frame: OrbitFrame | null = null;
  private view: EarthView = 'follow';
  private distance = .6;
  private rim: THREE.Mesh;
  private draco = new DRACOLoader().setDecoderPath('/earth/draco/').setWorkerLimit(1);

  constructor(canvas: HTMLCanvasElement, onExplore: () => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x020407);
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = .95;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = false;
    this.controls.minDistance = .15;
    this.controls.maxDistance = 2;
    this.controls.addEventListener('start', () => {
      if (this.view === 'globe' || this.view === 'down') this.setView('follow');
      this.view = 'explore';
      onExplore();
    });
    this.world.add(new THREE.Mesh(
      new THREE.SphereGeometry(6378.137, 192, 96),
      new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 8, specular: 0x111820 }),
    ));
    this.world.children[0].scale.y = 6356.752314 / 6378.137;
    this.world.add(this.earthSun);
    this.near.add(this.craft, this.sun, new THREE.AmbientLight(0x7497ba, .055));
    this.rim = new THREE.Mesh(new THREE.SphereGeometry(6395, 128, 64), new THREE.ShaderMaterial({
      uniforms: { sunDirection: { value: new THREE.Vector3(1, 0, 0) } },
      vertexShader: 'varying vec3 n; varying vec3 v; void main(){ n=normalize(normalMatrix*normal); v=-(modelViewMatrix*vec4(position,1.0)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 sunDirection; varying vec3 n; varying vec3 v; void main(){ float edge=pow(1.0-abs(dot(normalize(n),normalize(v))),7.0); float day=smoothstep(-.15,.35,dot(normalize(n),sunDirection)); gl_FragColor=vec4(.17,.44,.8,edge*day*.38); }',
      transparent: true, side: THREE.FrontSide, depthWrite: false,
    }));
    this.rim.scale.y = 6356.752314 / 6378.137;
    this.world.add(this.rim);
  }

  async load(signal: AbortSignal) {
    const [imageResponse, modelResponse] = await Promise.all([
      fetch('/earth/earth-october.jpg', { signal }), fetch('/earth/iss.glb', { signal }),
    ]);
    if (!imageResponse.ok || !modelResponse.ok) throw new Error('Earth assets unavailable');
    const [blob, buffer] = await Promise.all([imageResponse.blob(), modelResponse.arrayBuffer()]);
    if (signal.aborted || this.disposed) throw new Error('Cancelled');
    // Bound the retained texture to 4096×2048 (~43 MiB including mipmaps).
    const bitmap = await createImageBitmap(blob, { resizeWidth: Math.min(4096, this.renderer.capabilities.maxTextureSize),
      resizeHeight: Math.min(4096, this.renderer.capabilities.maxTextureSize) / 2 });
    if (signal.aborted || this.disposed) { bitmap.close(); throw new Error('Cancelled'); }
    const surface = document.createElement('canvas');
    surface.width = bitmap.width; surface.height = bitmap.height;
    const context = surface.getContext('2d');
    if (!context) { bitmap.close(); throw new Error('Texture preparation unavailable'); }
    context.drawImage(bitmap, 0, 0); bitmap.close();
    this.texture = new THREE.CanvasTexture(surface);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;
    this.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const earth = this.world.children[0] as THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhongMaterial>;
    earth.material.map = this.texture; earth.material.needsUpdate = true;
    const gltf = await new GLTFLoader().setDRACOLoader(this.draco).parseAsync(buffer, '');
    if (signal.aborted || this.disposed) { this.disposeObject(gltf.scene); throw new Error('Cancelled'); }
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    const scale = .109 / Math.max(size.x, size.y, size.z);
    gltf.scene.position.copy(center).multiplyScalar(-scale);
    gltf.scene.scale.setScalar(scale);
    this.craft.add(gltf.scene);
  }

  setView(view: EarthView) {
    if (view === 'explore' && this.frame && this.view !== 'explore') {
      this.view = 'follow'; this.placeCamera(this.frame);
    }
    this.view = view; this.distance = .6;
    if (this.frame) this.placeCamera(this.frame);
  }
  key(key: string) {
    if (key === 'Home') { this.setView('follow'); return; }
    if (this.view !== 'explore') this.setView('explore');
    if (key === '+' || key === '-') {
      const next = THREE.MathUtils.clamp(this.camera.position.length() * (key === '+' ? .9 : 1.1), .15, 2);
      this.camera.position.setLength(next);
    } else {
      const axis = key === 'ArrowLeft' || key === 'ArrowRight' ? this.camera.up :
        this.camera.position.clone().cross(this.camera.up).normalize();
      this.camera.position.applyAxisAngle(axis, key === 'ArrowLeft' || key === 'ArrowUp' ? .08 : -.08);
    }
    this.camera.lookAt(0, 0, 0);
  }
  private placeCamera(frame: OrbitFrame) {
    const radial = vec(frame.radial), along = vec(frame.along), normal = vec(frame.normal);
    if (this.view === 'follow') {
      this.camera.position.copy(along).multiplyScalar(-.43 * this.distance)
        .addScaledVector(radial, .24 * this.distance).addScaledVector(normal, .16 * this.distance);
      this.camera.up.copy(radial);
      this.camera.lookAt(0, 0, 0);
    } else if (this.view === 'down') {
      this.camera.position.set(0, 0, 0);
      this.camera.up.copy(along);
      this.camera.lookAt(radial.clone().multiplyScalar(-1));
    } else if (this.view === 'globe') {
      this.camera.position.copy(radial).multiplyScalar(13_000);
      this.camera.up.copy(along);
      this.camera.lookAt(0, 0, 0);
    }
  }

  render(frame: OrbitFrame, width: number, height: number) {
    if (this.disposed || width < 1 || height < 1) return;
    this.frame = frame;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
      this.earthCamera.aspect = width / height; this.earthCamera.updateProjectionMatrix();
    }
    this.placeCamera(frame);
    const basis = new THREE.Matrix4().makeBasis(vec(frame.normal), vec(frame.radial), vec(frame.along));
    this.craft.quaternion.setFromRotationMatrix(basis);
    this.sun.position.copy(vec(frame.sun)).multiplyScalar(10);
    this.sun.intensity = frame.shadow ? 0 : 3;
    this.earthSun.position.copy(vec(frame.sun)).multiplyScalar(25_000);
    this.earthCamera.position.copy(vec(frame.position)).add(this.camera.position);
    this.earthCamera.quaternion.copy(this.camera.quaternion);
    this.earthCamera.updateMatrixWorld();
    (this.rim.material as THREE.ShaderMaterial).uniforms.sunDirection.value.copy(vec(frame.sun)).transformDirection(this.earthCamera.matrixWorldInverse);
    this.renderer.clear();
    this.renderer.render(this.world, this.earthCamera);
    if (this.view !== 'down' && this.view !== 'globe') {
      this.renderer.clearDepth();
      this.renderer.render(this.near, this.camera);
    }
  }

  private disposeObject(root: THREE.Object3D) {
    const textures = new Set<THREE.Texture>();
    root.traverse(node => {
      const mesh = node as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      for (const material of materials) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture && value !== this.texture) textures.add(value);
        material.dispose();
      }
    });
    for (const texture of textures) {
      texture.dispose();
      if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.controls.dispose();
    this.draco.dispose();
    this.disposeObject(this.world); this.disposeObject(this.near);
    const surface = this.texture?.image as HTMLCanvasElement | undefined;
    this.texture?.dispose();
    if (surface) { surface.width = 0; surface.height = 0; }
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
