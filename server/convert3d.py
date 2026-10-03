import bpy
import os
import sys

def args_after_dash():
    if "--" not in sys.argv:
        raise RuntimeError("Argumentos de conversão ausentes.")
    return sys.argv[sys.argv.index("--") + 1:]

def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

def import_obj(path):
    if hasattr(bpy.ops.wm, "obj_import"):
        bpy.ops.wm.obj_import(filepath=path)
    else:
        bpy.ops.import_scene.obj(filepath=path)

def import_fbx(path):
    bpy.ops.import_scene.fbx(filepath=path)

args = args_after_dash()
if len(args) < 3:
    raise RuntimeError("Uso: input output ext")

source, output, ext = args[0], args[1], args[2].lower()
if not os.path.isfile(source):
    raise RuntimeError("Arquivo de origem não encontrado.")

if ext == "blend":
    bpy.ops.wm.open_mainfile(filepath=source)
elif ext == "obj":
    clear_scene()
    import_obj(source)
elif ext == "fbx":
    clear_scene()
    import_fbx(source)
else:
    raise RuntimeError("Formato 3D não suportado.")

for obj in bpy.context.scene.objects:
    try:
        obj.hide_render = False
        obj.hide_viewport = False
    except Exception:
        pass

bpy.ops.export_scene.gltf(
    filepath=output,
    export_format="GLB",
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT"
)

if not os.path.isfile(output) or os.path.getsize(output) <= 0:
    raise RuntimeError("O Blender não gerou um GLB válido.")

print("STUDIO_K_GLTF_OK", output)
