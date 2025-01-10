import { quat, vec3, mat4 } from 'glm';

import { Camera, Transform } from '../core.js';

import { maxSpeed } from './FirstPersonController.js';

import { getGlobalModelMatrix } from '../core/SceneUtils.js';

// export this.cameraRigidBody in AmmoLib instance za uporabo v FirstPersonController
export let camRigidBody;
export let AmmoLibExport;

//////////////////////////
// COLLISION DETECTION //
/////////////////////////
/* V temu class-u se naredi 
    - (handleInit) instanca Ammo.js
    - (handleInit) iz scene izluščijo vsi modeli/nodes in razporedijo v pravilne tabele (static -> this.staticModelsData, dynamic -> this.modelsData, nc_ -> nikamor)
        - DELITEV MODELOV
            - camera, static models (plane, trees, flowers, grass, portal, playing board, ...), dynamic models (stone dude, apples, X's, ...) in modeli brez rigidBody-jev (nodes od class-ov, ki so dodani sceni, light in modeli ki se začnejo z nc_(to pomeni no collision))
            - static se delijo (imajo vsi rigid bodies)
                - static podlaga (plane, hell)
                - static objects (trees, flowers, grass)
                - triggers (portal, playing board) (imajo dodatno še rigid body za trigger, ki je enak kot navaden rigidBody + margin)
            - dynamic se delijo
                - dynamic objects (stone dude, apples)
                - triggers (X's) (imajo dodatno še rigid body za trigger, ki je enak kot navaden rigidBody + margin)
        - interakcije med skupinami modelov so definirane z groups in masks
        - INSTANCES: v gltf so vsi modeli, ki imajo instance - torej parent modeli na 0, 0, 0 (TRS), instance-i so tako v word coordinates. Instances se končajo z . in tremi številkami (.000, .099, .765)
    - (addAllObjects, addObject) Za vsak model v staticModelsData in modelsData se naredi rigidBody in se doda v physics world
        - Za vse modele ki so označeni z _trigger se naredi še triggerRigidBody
        - (addPlayerCameraRigidBody) Za kamero se naredi poseben rigidBody, ker je edini objekt ki nima fizičnega modela
        - (aabb_sphere, bvhStatic, convexHull) Različni tipi rigidBody-jev (aabb, sphere, mesh) glede na model
    - (updatePhysics v setupGameLoop) Vsak frame se kliče updatePhysics, ki:
        - advance the physics world
        - (syncPlayerCameraTR) synchronize camera translation and rotation with cameraRigidBody position and rotation
        - (syncObjects) synchronize vse modele z njihovimi rigidBody-ji
        - (checkCollisions) check for trigger collisions
            - (checkForTriggers) Kličemo gameplay funkcije, izpise na ekran (main.js)
*/

export class CollisionDetection {

    constructor(scene) {
        this.scene = scene; // scene from main.js
        this.camera = scene.find(node => node.getComponentOfType(Camera)); // camera from main.js

        // TABELE ZA MODELE
        this.staticModelsData = []; // tabela za shranjevanje podatkov o staticnih modelih
        this.modelsData = []; // tabela za shranjevanje podatkov o dynamicnih modelih

        // RIGID BODIES
        this.rigidBodyMap = new Map(); // map rigidBodyjev od vseh modelov, ki jih imajo (rigidBody id, model name)
        this.triggerRigidBodyMap = new Map(); // map rigidBodyjev od vseh modelov, ki imajo dodatno še rigidBody za trigger
        this.cameraRigidBody = null; // specifičen rigidBody za kamero / playerja

        this.regex = /\.\d{3}/; // za testiranje če je model an instance (konča se z . in tremi številkami)

        //
        // GAME MECHANICS
        //
        this.pickUpObject = false;
        this.teleport = false;
        this.playLevel1 = false;

        //
        // GROUPS AND MASKS
        //
        this.GROUP_CAMERA = 1 << 0;
        this.GROUP_PLANE = 1 << 1;
        this.GROUP_STATIC = 1 << 2;
        this.GROUP_STATIC_TRIGGER = 1 << 3;
        this.GROUP_DYNAMIC = 1 << 4;
        this.GROUP_DYNAMIC_TRIGGER = 1 << 5;

        this.MASK_CAMERA = this.GROUP_PLANE | this.GROUP_STATIC | this.GROUP_STATIC_TRIGGER | this.GROUP_DYNAMIC | this.GROUP_DYNAMIC_TRIGGER;
        this.MASK_PLANE = this.GROUP_DYNAMIC | this.GROUP_CAMERA;
        this.MASK_STATIC = this.GROUP_CAMERA | this.GROUP_DYNAMIC;
        this.MASK_STATIC_TRIGGER = this.GROUP_CAMERA;
        this.MASK_DYNAMIC = this.GROUP_PLANE | this.GROUP_CAMERA | this.GROUP_STATIC;
        this.MASK_DYNAMIC_TRIGGER = this.GROUP_CAMERA;

        this.handleInit();
    }

    handleInit() {

        //////////////////////////////////////////////////////////////
        // IMPORT MODELS in RAZDELJEVANJE V TABELE (static/dynamic) //
        //////////////////////////////////////////////////////////////

        var tmpData = [];
        let instances = [];

        // Gremo čez vse nodes v sceni
            // dodamo vse v tmpData, da jih potem razdelimo v modelsData in staticModelsData
            // spustimo nc_ -> no collision
            // če so instance, jih dodamo v instances, da jih kasneje razdelimo
        this.scene.traverse(node => {
            // če je no collision, ga spustimo
            if (node.name && !node.name.startsWith("nc_")) {

                // ČE JE INSTANCE, ga dodamo v instances tabelo
                if (this.regex.test(node.name)) {
                    let imeOriginala = node.name;
                    imeOriginala = imeOriginala.replace(this.regex, ""); // naredimo ime originala

                    instances.push({
                        name: node.name,
                        original: imeOriginala,
                        position: [...this.clampToDecimals(node.components[0].translation, 5)],
                        rotation: [...this.clampToDecimals(node.components[0].rotation, 5)],
                        scale: [...this.clampToDecimals(node.components[0].scale, 5)]
                    });
                }

                // Vzamemo podatke iz node-a, ki jih bomo rablili za izračun collision boxes in jih damo v tmpData
                    // Pogledamo če ima model komponento Mesh, če je nima, pomeni da je Camera ali Light in jih ne rabimo
                const meshPrimitives = node.components?.[1]?.primitives;
                meshPrimitives?.forEach(primitive => {
                    if (primitive) {
                        // Da se izognemo podvojenim zapisom v tmpData za vsak primitive od node-a:
                        // Pogledamo če model že obstaja v tmpData
                        let obstojeciModel;
                        let zeObstaja = false;
                        tmpData.forEach(model => {
                            if (model.name === node.name) {
                                obstojeciModel = tmpData.find(tmpData => tmpData.name === node.name);
                                zeObstaja = true;
                            }
                        });

                        // če že obstaja, pripnemo podatke v obstoječi tmpData zapis
                        if (zeObstaja) {
                            obstojeciModel.vertices.push(...primitive.mesh.vertices);
                            const indexOffset = obstojeciModel.vertices.length / 3; // Adjust indices for offset
                            const skupneIndices = primitive.mesh.indices.map(index => index + indexOffset);
                            obstojeciModel.indices.push(...skupneIndices);
                        }
                        // Če še ne obstajamo, dodamo nov zapis v tmpData
                        else {
                            tmpData.push({
                                name: node.name,
                                vertices: [...primitive.mesh.vertices],
                                indices: [...primitive.mesh.indices],
                                position: [...this.clampToDecimals(node.components[0].translation, 5)],
                                rotation: [...this.clampToDecimals(node.components[0].rotation, 5)],
                                scale: [...this.clampToDecimals(node.components[0].scale, 5)],
                            });
                        }
                    }
                });
            }
        });

        // INSTANCES
        // Če je model instance, pomeni da ima svoj translation, rotation and scale, nima pa svojih vertices in indices
        // Zato vzamemo podatke vertices in indices iz originala, TRS od instance-a, parentModela pa ne izrižemo
        tmpData.forEach(parentModel => {
            instances.forEach(instance => {
                if (parentModel.name === instance.original) {

                    tmpData.push({
                    name: instance.name,
                    vertices: [...parentModel.vertices],
                    indices: [...parentModel.indices],
                    position: instance.position,
                    rotation: instance.rotation,
                    scale:    instance.scale
                    });

                    parentModel.isOriginal = true;
                }
            });
        });

        // Zbrišemo vse originale/parents instance-ov iz tmpData, da se ne bodo izrisovali
        tmpData = tmpData.filter(model => !model.isOriginal);

        //
        // RAZDELIMO MODELE V PRAVILNE TABELE (staticModelsData, modelsData)
        //
        // če se model v gltf začne z dy_ je dynamic, sicer je static
        // static modeli se ne bodo več premikali, dynamic pa bo čekiran vsak frame, če se je premaknil
        tmpData.forEach(model => {
            if (model.name.startsWith("dy_")) {
                this.modelsData.push(model);
            } 
            else {
                this.staticModelsData.push(model);
            }
        });

        console.log("modelsData: ", this.modelsData);
        console.log("staticModelsData: ", this.staticModelsData);


        /////////////////
        // IMPORT AMMO //
        ////////////////
        // Create physics world
        Ammo().then((AmmoLib) => {
            //
            // Inicializacija Ammo.js
            //
            // Creating the physics world
            const collisionConfiguration = new AmmoLib.btDefaultCollisionConfiguration();
            const dispatcher = new AmmoLib.btCollisionDispatcher(collisionConfiguration); // responsible for managing collision algorithms
            const broadphase = new AmmoLib.btDbvtBroadphase(); // broad-phase collision detection - checks potential collisions for simple objects
            const solver = new AmmoLib.btSequentialImpulseConstraintSolver(); // actual collision
            const physicsWorld = new AmmoLib.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, collisionConfiguration); // integrates all components and creates the physics worls, manages physics simulation
            physicsWorld.setGravity(new AmmoLib.btVector3(0, -5.81, 0));

            //
            // Dodamo modele v physics world - posebej static in dynamic
            //
            this.addAllObjects(physicsWorld, AmmoLib, this.modelsData, 0, 1); // flag = 0, mass = 1 for dynamic
            this.addAllObjects(physicsWorld, AmmoLib, this.staticModelsData, 1, 0); // flag = 1, mass = 0 for static

            // Dodamo rigidBody okoli kamere - to je player v physics world
            this.cameraRigidBody = this.addPlayerCameraRigidBody(physicsWorld, AmmoLib);
            if (!this.cameraRigidBody) {
                console.error("Failed to add camera rigid body.");
            } else {
                this.rigidBodyMap.set(this.cameraRigidBody, { name: "Camera" });
            }

            // Nastavimo instanco Ammo za export
            AmmoLibExport = AmmoLib;

            // Run the game loop
            this.setupGameLoop(physicsWorld, AmmoLib);

        }).catch((error) => {
            console.error('Failed to initialize Ammo.js:', error);
        });
    }

    // Ta funckija se zgodi enkrat na začetku, updatePhysics pa vsak frame - kličemo jo v main.js update
    setupGameLoop(physicsWorld, AmmoLib) {
        this.updatePhysics = (timeStep, maxSubSteps, dt) => {
            // Advances the physics world
            physicsWorld.stepSimulation(timeStep, maxSubSteps);

            // Translation, rotation kamere = cameraRigidBody position, rotation
            this.syncPlayerCameraTR(this.cameraRigidBody, this.camera, AmmoLib, dt);

            // Synchronize vse actual modele z positions, rotations of their respective rigid bodies
            this.syncObjects(AmmoLib);

            // Check for trigger collisions (collision detection and response naredi Ammo sam)
            this.checkCollisions(physicsWorld, AmmoLib);
        };
    }

    ///////////////////////////////////////////////////////////////////////
    // CREATE A RIGIDBODY FOR EVERY MODEL AND ADD IT TO THE PHYSICS WORLD//
    ///////////////////////////////////////////////////////////////////////
        // Add all objects to the physics world, razdeljeni na static in dynamic
        // Ta funkcija se zgodi enkrat, potem se pa vsak frame kliče syncObjects
        // mass = mass, ki ga bomo nastavili rigidBody-ju (če je 0, je static, če je 1, je dynamic)
        // flag = collision flag, ki ga bomo nastavili rigidBody-ju (0 za dynamic, 1 za static)
    addAllObjects(physicsWorld, AmmoLib, modelType, flag, mass) {
        // Gremo čez vse modelType (staticModelsData ali modelsData)
        modelType.forEach(model => {
            const { vertices, indices, name, position, rotation, scale } = model; // podatki, ki smo jih prej vzeli iz node-ov

            // dodamo specifične parametre za določene modele
            let aabb = false;
            let sphere = false;
            if (name == "dy_stone dude") { // stone dude mora biti težek in imeti aabb, če ne pade po tleh (njegov model stoji na prstih)
                mass = 200;
                aabb = true;
            }
            // Če se model začne z aabb_ mu nastavimo box collision 
            else if (name.startsWith("aabb_")) {
                aabb = true;
            }
            // Če se model začne z sphere_ mu nastavimo sphere collision 
            else if (name.startsWith("sphere_")) {
                sphere = true;
            }
            // Apple je lahek da ga lahko brcamo okoli 
            else if (name.startsWith("dy_apple")) {
                mass = 0.3;
            }
            // Ostali modeli, ki nimajo teh posebnosti, bodo imeli mesh collision box, default mass (1 ali 0)

            ////////////////////////
            // TRIGGER RIGID BODY //
            ////////////////////////
                // Če ima model tag _trigger, mu dodamo še triggerRigidBody, tako da bo imel 2 rigiBody-ja
                // flag = 4 je btCollisionObject.CF_NO_CONTACT_RESPONSE, tako, da se za njega ne bo računala nobena fizika
            if (name.endsWith("_trigger")) {
                this.addObject(vertices, indices, AmmoLib, physicsWorld, 4, 0, position, rotation, scale, false, true, true, name)
                .then(rigidBody => {
                    model.triggerRigidBody = rigidBody;
                    this.triggerRigidBodyMap.set(rigidBody.kB, { name: name });
                    //console.log("Object ", name, " added successfully.");
                })
                .catch((error) => {
                    if (modelType === this.modelsData) console.error("Failed to add triggerRigidBody for DYNAMIC object", name , error);
                    else console.error("Failed to add triggerRigidBody for STATIC object", name, error);
                });
            }

            /////////////////
            // RIGID BODY //
            /////////////////
            this.addObject(vertices, indices, AmmoLib, physicsWorld, flag, mass, position, rotation, scale, aabb, sphere, false, name)
            .then(rigidBody => {
                model.rigidBody = rigidBody;
                this.rigidBodyMap.set(rigidBody, { name: name });
            })
            .catch((error) => {
                if (modelType === this.modelsData) console.error("Failed to add rigidBody for DYNAMIC object", name , error);
                else console.error("Failed to add rigidBody for STATIC object", name, error);
            });

            // Naredimo delay med dodajanji rigidBody-jev, da se izognemo error-jem z Ammo.js
            this.delay(50);
        });
    }

    //
    // CREATE THE ACTUAL RIGID BODY 
    //
    addObject(vertices, indices, AmmoLib, physicsWorld, flag, mass, initialPosition, initialRotation, initialScale, aabb, sphere, trigger, name) {
        return new Promise((resolve, reject) => {
            try {
                var shape;

                //
                // GET THE SHAPE for the rigid body
                //
                // Če je trigger, bo imel vedno sphere, če aabb -> aabb, če sphere -> sphere, drugače pa mesh
                if (trigger) {
                    shape = this.aabb_sphere(AmmoLib, vertices, "sphere", 1, 3);
                } else if (aabb) {
                    shape = this.aabb_sphere(AmmoLib, vertices, "aabb", 0, 0);
                } else if (sphere) {
                    shape = this.aabb_sphere(AmmoLib, vertices, "sphere", 0, 0);
                }
                // Če nima nobenega od teh, je mesh collision
                else {
                    // Če je static mora imeti btBvhTriangleMeshShape
                    if (flag == 1) {
                        shape = this.bvhStatic(AmmoLib, vertices, indices);
                    } 

                    // Če je dynamic, mora imeti btConvexHullShape
                    else if (flag == 0) {
                        shape = this.convexHull(AmmoLib, vertices);
                    }
                }

                // če je ta rigid body a trigger mu dodamo margin
                if (trigger) {
                    shape.setMargin(20);
                }

                // Rigid body moramo narediti z transformom, na katerem stoji renderan objekt
                const transform = new AmmoLib.btTransform();
                transform.setIdentity();

                // Translation
                transform.setOrigin(new AmmoLib.btVector3(initialPosition[0], initialPosition[1], initialPosition[2]));

                // Rotation
                const rotation = new AmmoLib.btQuaternion(initialRotation[0], initialRotation[1], initialRotation[2], initialRotation[3]);
                transform.setRotation(rotation);

                // Scale
                const scaling = new AmmoLib.btVector3(initialScale[0], initialScale[1], initialScale[2]);
                shape.setLocalScaling(scaling);

                const motionState = new AmmoLib.btDefaultMotionState(transform);

                // If mass > 0, we need to calculate local inertia:
                const localInertia = new AmmoLib.btVector3(0, 0, 0);
                if (mass > 0) {
                    shape.calculateLocalInertia(mass, localInertia);
                }
                const rigidBodyInfo = new AmmoLib.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
                const rigidBody = new AmmoLib.btRigidBody(rigidBodyInfo);

                // flag: 
                    // 1 for static objects, 
                    // 2 for kinematic objects, 
                    // 0 for dynamic,
                    // 4 for trigger objects
                rigidBody.setCollisionFlags(flag);

                // Add the rigid body to the physics world, with speicifc groups and masks, so they know how to interact with each other
                if (name.startsWith("Plane") || name.startsWith("Hell")) {
                    physicsWorld.addRigidBody(rigidBody, this.GROUP_PLANE, this.MASK_PLANE);
                }
                // dynamic objects (triggers and non triggers)
                else if (name.startsWith("dy_")) {
                    if (trigger) {
                        physicsWorld.addRigidBody(rigidBody, this.GROUP_DYNAMIC_TRIGGER, this.MASK_DYNAMIC_TRIGGER);
                    } else {
                        physicsWorld.addRigidBody(rigidBody, this.GROUP_DYNAMIC, this.MASK_DYNAMIC);
                    }
                }
                // static objects (triggers and non triggers)
                else {
                    if (trigger) {
                        physicsWorld.addRigidBody(rigidBody, this.GROUP_STATIC_TRIGGER, this.MASK_STATIC_TRIGGER);
                    } else {
                        physicsWorld.addRigidBody(rigidBody, this.GROUP_STATIC, this.MASK_STATIC);
                    }
                }

                resolve(rigidBody);

            } catch (error) {
                reject(error);
            }
        });
    }

    //
    // SPHERE ALI AABB ZA RIGID BODY
    //
    // za katerekoli modele
    aabb_sphere(AmmoLib, vertices, type, trigger, triggerMargin) {
        let min = [Infinity, Infinity, Infinity];
        let max = [-Infinity, -Infinity, -Infinity];

        for (let i = 0; i < vertices.length; i ++) {
            var vertexPos = vertices[i].position;

            min[0] = Math.min(min[0], vertexPos[0]);
            min[1] = Math.min(min[1], vertexPos[1]);
            min[2] = Math.min(min[2], vertexPos[2]);

            max[0] = Math.max(max[0], vertexPos[0]);
            max[1] = Math.max(max[1], vertexPos[1]);
            max[2] = Math.max(max[2], vertexPos[2]);
        }

        const halfExtents = [
            (max[0] - min[0]) / 2,
            (max[1] - min[1]) / 2,
            (max[2] - min[2]) / 2
        ];

        // AABB
        if (type == "aabb") {
            return (new AmmoLib.btBoxShape(new AmmoLib.btVector3(halfExtents[0], halfExtents[1], halfExtents[2])));
        } 
        // SPHERE
        else if (type == "sphere") {
            // TRIGGER SPHERE
            if (trigger) {
                return (new AmmoLib.btSphereShape(triggerMargin));
            }
            // NON TRIGGER SPHERE
            return (new AmmoLib.btSphereShape(halfExtents[0]));

        } else {
            console.error("Invalid type for aabb_sphere function.");
        }
    }

    //
    // BVH TRIANGLE MESH ZA RIGID BODY
    //
    // za static modele
    bvhStatic(AmmoLib, vertices, indices) {
        // Create btTriangleMesh
        const triangleMesh = new AmmoLib.btTriangleMesh();

        // Add the triangles (iz vertices in indices) v ta triangle mesh
        for (let i = 0; i < indices.length; i += 3) {
            const index0 = indices[i];
            const index1 = indices[i + 1];
            const index2 = indices[i + 2];

            // Naredimo Ammo vector za vsak vertex
            const vertex0 = new AmmoLib.btVector3(vertices[index0].position[0], vertices[index0].position[1], vertices[index0].position[2]);
            const vertex1 = new AmmoLib.btVector3(vertices[index1].position[0], vertices[index1].position[1], vertices[index1].position[2]);
            const vertex2 = new AmmoLib.btVector3(vertices[index2].position[0], vertices[index2].position[1], vertices[index2].position[2]);

            // Dodamo trikotnik v triangle mesh
            triangleMesh.addTriangle(vertex0, vertex1, vertex2);

            // Free the memory
            AmmoLib.destroy(vertex0);
            AmmoLib.destroy(vertex1);
            AmmoLib.destroy(vertex2);
        }

        // Create a collision shape (for static objects btBvhTriangleMeshShape)
        return(new AmmoLib.btBvhTriangleMeshShape(triangleMesh, true));
    }

    //
    // CONVEX HULL ZA RIGID BODY
    //
    // za dynamic modele
    convexHull(AmmoLib, vertices) {
        let shape = new AmmoLib.btConvexHullShape();

        for (let i = 0; i < vertices.length; i ++) {
            var vertexPos = vertices[i].position;
            const vx = vertexPos[0];
            const vy = vertexPos[1];
            const vz = vertexPos[2];

            // Temporary Ammo vektor
            const tempVec = new AmmoLib.btVector3(vx, vy, vz);

            // Dodamo tpčko v hull
            shape.addPoint(tempVec, true);

            // Free memory
            AmmoLib.destroy(tempVec);
        }

        return shape;
    }

    //
    // Sync all objects with their respective rigid bodies
    //
    // Vsak frame translation, rotation modelov nastavimo na translation, rotation od njihovih rigidBody-jev
        // To omogoča, da Ammo kalkulira končno fiziko in da se pozna collision/gravity itd.
    syncObjects(AmmoLib) {
        this.modelsData.forEach(model => {
            // odstrani rigidBody če pade dol

            if (!model.rigidBody) {
                console.warn(`Rigid body not found for model: ${model.name}`);
                return;
            }
    
            const motionState = model.rigidBody.getMotionState();
            if (motionState) {
                const transform = new AmmoLib.btTransform();
                motionState.getWorldTransform(transform);
        
                const origin = transform.getOrigin();
                const rotation = transform.getRotation();
        
                const node = this.scene.find(node => node.name === model.name);
                const transformComponent = node.getComponentOfType(Transform);
        
                if (transformComponent) { // naj bodo vsi dynamic objects na tleh ali da padajo
                    transformComponent.translation = [origin.x(), origin.y(), origin.z()];
                    transformComponent.rotation = quat.fromValues(
                        rotation.x(),
                        rotation.y(),
                        rotation.z(),
                        rotation.w()
                    );
                }

                // Če ima model tudi trigger body, mu nastavimo triggerBody = rigidBody position
                if (model.triggerRigidBody) {
                    //console.log("Setting trigger body position: ", origin.x(), origin.y(), origin.z());
                    const triggerBodyTransform = new AmmoLib.btTransform();
                    model.triggerRigidBody.getMotionState().getWorldTransform(triggerBodyTransform);

                    triggerBodyTransform.setOrigin(origin);
                    model.triggerRigidBody.setWorldTransform(triggerBodyTransform);
                    model.triggerRigidBody.getMotionState().setWorldTransform(triggerBodyTransform);

                    AmmoLib.destroy(triggerBodyTransform);
                }
        
                AmmoLib.destroy(transform);
            }
        });
    }

    ///////////////////////////////////
    // ADD PLAYER/CAMERA RIGID BODY //
    //////////////////////////////////
    // Podobno kot addAllObjects, samo za playerja/kamero
    // Naredimo box collision shape okoli kamere, dodamo v physics world
    addPlayerCameraRigidBody(physicsWorld, AmmoLib) {
        // Create a box collision shape
        const halfExtents = new AmmoLib.btVector3(0.3, 1, 0.3); // half dimensions of the box
        const boxShape = new AmmoLib.btBoxShape(halfExtents);
    
        // Create the rigid body
        const transform = new AmmoLib.btTransform();
        transform.setIdentity();
        transform.setOrigin(new AmmoLib.btVector3(50, 20, 50));

        const motionState = new AmmoLib.btDefaultMotionState(transform);
    
        const mass = 1;
        const localInertia = new AmmoLib.btVector3(0, 0, 0);
        boxShape.calculateLocalInertia(mass, localInertia);

        const rigidBodyInfo = new AmmoLib.btRigidBodyConstructionInfo(mass, motionState, boxShape, localInertia);
        const rigidBody = new AmmoLib.btRigidBody(rigidBodyInfo);
        rigidBody.setAngularFactor(new Ammo.btVector3(0, 0, 0)); // Prevent the camera from rotating / falling over
    
        rigidBody.setCollisionFlags(0); // dynamic
        rigidBody.setDamping(0.2, 0.0); // 50% linear damping, 0% angular damping

        rigidBody.setActivationState(4); // Disable deactivation for the camera
    
        // Add the rigid body to the physics world
        physicsWorld.addRigidBody(rigidBody, this.GROUP_CAMERA, this.MASK_CAMERA);
    
        // Clean up temporary Ammo.js objects
        AmmoLib.destroy(halfExtents);
        AmmoLib.destroy(transform);
        AmmoLib.destroy(localInertia);

        camRigidBody = rigidBody;

        this.camera.components[1].fovy = 0.7;

        this.rigidBodyMap.set(rigidBody, { name: "Camera" });
        this.cameraRigidBody = rigidBody;
        return rigidBody;
    }

    //
    // Sync the camera/player with the camera/player's rigid body
    //
    // Camera transforms = origin, rotation od njegovega rigid Bodyja
        // To omogoča, da Ammo kalkulira končno fiziko in da se pozna collision/gravity itd.
    // Keyboard controls so v FirstPersonController.js, ki se zgodijo najprej, nato pa ta funkcija
    syncPlayerCameraTR(rigidBody, camera, AmmoLib, dt) {
        // preberemo from ammo/bullet kje je rigid body od kamere
        const transform = new AmmoLib.btTransform();
        rigidBody.getMotionState().getWorldTransform(transform);
    
        // preberemo koordinate rigid body od kamere
        const origin = transform.getOrigin();
        const rotation = transform.getRotation();

        // find the nodes transform component
        const cameraTransform  = camera.getComponentOfType(Transform);
        if (cameraTransform) {
            // nastavimo translation kamere na njen rigid body position
            cameraTransform.translation = [origin.x(), origin.y() + 0.8, origin.z()];
            cameraTransform.rotation = quat.fromValues(
                rotation.x(),
                rotation.y(),
                rotation.z(),
                rotation.w()
            );
        }

        // IZPIS CAMERA POSITION
        //console.log("Camera pos:", cameraTransform.translation);

        // IZPIS CAMERA RIGID BODY POSITION
        //console.log("Camera rigid:", origin.x(), origin.y(), origin.z());
            
        AmmoLib.destroy(transform);
    }

    //////////////////////////////////
    // CHECK FOR TRIGGER COLLISIONS //
    /////////////////////////////////
    // Gledamo samo za collisions z trigger rigid bodies
        // navadni rigid bodies imajo fiziko že avtomatsko implementiramo, tako da ne rabimo nič dodajat
    // Dodamo gameplay calls, če se trigger sproži
    checkCollisions(physicsWorld) {
        const dispatcher = physicsWorld.getDispatcher();
        const numManifolds = dispatcher.getNumManifolds();
        let triggerCollision = false;

        for (let i = 0; i < numManifolds; i++) {
            const contactManifold = dispatcher.getManifoldByIndexInternal(i);
            const bodyA = contactManifold.getBody0();
            const bodyB = contactManifold.getBody1();

            if (this.triggerRigidBodyMap.has(bodyA.kB)) {
                this.checkForTriggers(bodyA);
                triggerCollision = true;
            }
        }

        if (!triggerCollision) {
            this.pickUpObject = false;
            this.teleport = false;
            this.playLevel1 = false;
        }
    }

    // Check for triggers and call specific gameplay functions
    checkForTriggers(body) {
        console.log(body.kB);
        console.log(this.triggerRigidBodyMap.get(body.kB));

        var triggeredObject = this.triggerRigidBodyMap.get(body.kB);

        if (triggeredObject) {
            if (triggeredObject.name.includes("PlayingBoard")) {
                this.playLevel1 = true;
                this.teleport = false;
                this.pickUpObject = false;
            }
            else if (triggeredObject.name.includes("dy_X")) {
                this.pickUpObject = true;
                this.teleport = false;
            }
            else if (triggeredObject.name.includes("Portal")) {
                this.teleport = true;
                this.pickUpObject = false;
                this.playLevel1 = false;
            }
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    clampMatrix(matrix, decimal) {
        for (let i = 0; i < matrix.length; i++) {
            matrix[i] = this.clampToDecimals(matrix[i], decimal);
        }
        return matrix;
    }

    clampToDecimals(vector, decimal) {
        for (let i = 0; i < vector.length; i++) {
            vector[i] = parseFloat(vector[i].toFixed(decimal));
        }
        return vector;
    }
}