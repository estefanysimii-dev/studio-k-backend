use anyhow::{bail, Context, Result};
use rage_formats::{encode_image, parse_drawables, parse_ytd, rage_joaat, DrawableKind, ImageFormat, YtdTexture};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::Path;

fn align4(buf: &mut Vec<u8>, pad: u8) {
    while buf.len() % 4 != 0 {
        buf.push(pad);
    }
}

fn push_f32(buf: &mut Vec<u8>, value: f32) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn add_view(buffer_views: &mut Vec<Value>, bin: &mut Vec<u8>, bytes: &[u8], target: Option<u32>) -> usize {
    align4(bin, 0);
    let offset = bin.len();
    bin.extend_from_slice(bytes);
    let mut view = json!({
        "buffer": 0,
        "byteOffset": offset,
        "byteLength": bytes.len()
    });
    if let Some(target) = target {
        view["target"] = json!(target);
    }
    buffer_views.push(view);
    buffer_views.len() - 1
}

fn add_accessor(
    accessors: &mut Vec<Value>,
    view: usize,
    component_type: u32,
    count: usize,
    kind: &str,
    normalized: bool,
    min: Option<[f32; 3]>,
    max: Option<[f32; 3]>,
) -> usize {
    let mut accessor = json!({
        "bufferView": view,
        "byteOffset": 0,
        "componentType": component_type,
        "count": count,
        "type": kind
    });
    if normalized {
        accessor["normalized"] = json!(true);
    }
    if let Some(v) = min {
        accessor["min"] = json!(v);
    }
    if let Some(v) = max {
        accessor["max"] = json!(v);
    }
    accessors.push(accessor);
    accessors.len() - 1
}

fn transform_position(x: f32, y: f32, z: f32) -> [f32; 3] {
    // RAGE/FiveM assets are Z-up. glTF/model-viewer is Y-up.
    [x, z, -y]
}

fn texture_key(name: &str) -> String {
    name.trim().replace('\\', "/").rsplit('/').next().unwrap_or(name).to_ascii_lowercase()
}

fn choose_drawable<'a>(entries: &'a [rage_formats::DrawableEntry]) -> Result<&'a rage_formats::DrawableEntry> {
    entries
        .iter()
        .filter(|entry| entry.drawable.best_lod().is_some())
        .max_by_key(|entry| {
            entry.drawable.best_lod().map(|lod| {
                lod.models.iter().flat_map(|model| model.geometries.iter())
                    .map(|geometry| geometry.vertex_buffer.as_ref().map(|v| v.vertex_count as usize).unwrap_or(0))
                    .sum::<usize>()
            }).unwrap_or(0)
        })
        .context("O YDD não contém nenhum drawable com LOD utilizável.")
}

fn build_preview(ydd: &[u8], ytd: &[u8]) -> Result<(Vec<u8>, Value)> {
    let entries = parse_drawables(ydd, DrawableKind::Ydd)
        .context("Não foi possível interpretar o arquivo YDD.")?;
    if entries.is_empty() {
        bail!("O YDD não contém drawables.");
    }

    let external_textures = parse_ytd(ytd).context("Não foi possível interpretar o arquivo YTD.")?;
    let entry = choose_drawable(&entries)?;
    let drawable = &entry.drawable;
    let lod = drawable.best_lod().context("O drawable selecionado não possui LOD.")?;

    let mut texture_bank: HashMap<String, YtdTexture> = HashMap::new();
    for tex in &external_textures {
        texture_bank.entry(texture_key(&tex.name)).or_insert_with(|| tex.clone());
        texture_bank.entry(format!("#{:08x}", tex.name_hash)).or_insert_with(|| tex.clone());
    }
    if let Some(group) = &drawable.shader_group {
        for tex in &group.textures {
            texture_bank.entry(texture_key(&tex.name)).or_insert_with(|| tex.clone());
            texture_bank.entry(format!("#{:08x}", tex.name_hash)).or_insert_with(|| tex.clone());
        }
    }

    let mut bin = Vec::<u8>::new();
    let mut views = Vec::<Value>::new();
    let mut accessors = Vec::<Value>::new();
    let mut images = Vec::<Value>::new();
    let mut textures = Vec::<Value>::new();
    let mut materials = Vec::<Value>::new();
    let mut primitives = Vec::<Value>::new();
    let mut image_cache = HashMap::<String, (usize, bool)>::new();

    let mut mesh_count = 0usize;
    let mut vertex_count = 0usize;
    let mut triangle_count = 0usize;

    for model in &lod.models {
        for geometry in &model.geometries {
            let Some(vertex_buffer) = &geometry.vertex_buffer else { continue; };
            let Some(index_buffer) = &geometry.index_buffer else { continue; };
            let vertices = vertex_buffer.to_unified_vertices()
                .context("Falha ao decodificar os vértices do YDD.")?;
            if vertices.is_empty() || index_buffer.indices.is_empty() {
                continue;
            }

            let mut pos_bytes = Vec::with_capacity(vertices.len() * 12);
            let mut normal_bytes = Vec::with_capacity(vertices.len() * 12);
            let mut uv_bytes = Vec::with_capacity(vertices.len() * 8);

            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];

            for v in &vertices {
                let p = transform_position(v.position.x, v.position.y, v.position.z);
                let n = transform_position(v.normal.x, v.normal.y, v.normal.z);
                for axis in 0..3 {
                    min[axis] = min[axis].min(p[axis]);
                    max[axis] = max[axis].max(p[axis]);
                    push_f32(&mut pos_bytes, p[axis]);
                    push_f32(&mut normal_bytes, n[axis]);
                }
                push_f32(&mut uv_bytes, v.texcoord0.x);
                push_f32(&mut uv_bytes, v.texcoord0.y);
            }

            let mut index_bytes = Vec::with_capacity(index_buffer.indices.len() * 4);
            for &index in &index_buffer.indices {
                push_u32(&mut index_bytes, index);
            }

            let pos_view = add_view(&mut views, &mut bin, &pos_bytes, Some(34962));
            let normal_view = add_view(&mut views, &mut bin, &normal_bytes, Some(34962));
            let uv_view = add_view(&mut views, &mut bin, &uv_bytes, Some(34962));
            let index_view = add_view(&mut views, &mut bin, &index_bytes, Some(34963));

            let pos_accessor = add_accessor(&mut accessors, pos_view, 5126, vertices.len(), "VEC3", false, Some(min), Some(max));
            let normal_accessor = add_accessor(&mut accessors, normal_view, 5126, vertices.len(), "VEC3", false, None, None);
            let uv_accessor = add_accessor(&mut accessors, uv_view, 5126, vertices.len(), "VEC2", false, None, None);
            let index_accessor = add_accessor(&mut accessors, index_view, 5125, index_buffer.indices.len(), "SCALAR", false, None, None);

            let diffuse_name = drawable.diffuse_texture_name(geometry.shader_id).unwrap_or("").to_string();
            let diffuse_key = texture_key(&diffuse_name);
            let diffuse_hash_key = if diffuse_name.is_empty() { String::new() } else { format!("#{:08x}", rage_joaat(&diffuse_name.to_ascii_lowercase())) };
            let source_texture = texture_bank.get(&diffuse_key)
                .or_else(|| if diffuse_hash_key.is_empty() { None } else { texture_bank.get(&diffuse_hash_key) });

            let material_index = if let Some(source_texture) = source_texture {
                let cache_key = format!("{}#{:08x}", texture_key(&source_texture.name), source_texture.name_hash);
                let (texture_index, has_alpha) = if let Some(&(cached, cached_alpha)) = image_cache.get(&cache_key) {
                    (cached, cached_alpha)
                } else {
                    let rgba = rage_formats::decompress_texture(source_texture)
                        .with_context(|| format!("Falha ao decodificar a textura '{}'.", source_texture.name))?;
                    let has_alpha = rgba.chunks_exact(4).any(|px| px[3] < 250);
                    let image = rage_formats::image::RgbaImage::from_raw(
                        source_texture.width as u32,
                        source_texture.height as u32,
                        rgba,
                    ).context("A textura YTD gerou dimensões inválidas.")?;
                    let png = encode_image(&image, ImageFormat::Png, 100)
                        .with_context(|| format!("Falha ao preparar a textura '{}'.", source_texture.name))?;
                    let image_view = add_view(&mut views, &mut bin, &png, None);
                    images.push(json!({
                        "name": source_texture.name,
                        "mimeType": "image/png",
                        "bufferView": image_view
                    }));
                    textures.push(json!({
                        "source": images.len() - 1,
                        "sampler": 0
                    }));
                    let idx = textures.len() - 1;
                    image_cache.insert(cache_key, (idx, has_alpha));
                    (idx, has_alpha)
                };

                let mut material = json!({
                    "name": format!("shader_{}_{}", geometry.shader_id, diffuse_name),
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                        "baseColorTexture": { "index": texture_index },
                        "metallicFactor": 0.0,
                        "roughnessFactor": 0.78
                    },
                    "doubleSided": true
                });
                if has_alpha {
                    material["alphaMode"] = json!("BLEND");
                }
                materials.push(material);
                materials.len() - 1
            } else {
                materials.push(json!({
                    "name": format!("shader_{}", geometry.shader_id),
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [0.72, 0.72, 0.76, 1.0],
                        "metallicFactor": 0.0,
                        "roughnessFactor": 0.82
                    },
                    "doubleSided": true
                }));
                materials.len() - 1
            };

            // Roupas de ped no GTA/FiveM podem usar COLOR_0 para parâmetros internos
            // do shader. Em glTF, COLOR_0 multiplica a textura PBR e pode tingir
            // texturas brancas (por exemplo, amarelo). A prévia web portanto
            // preserva geometria, normal e UV, mas omite vertex colors por padrão.
            primitives.push(json!({
                "attributes": {
                    "POSITION": pos_accessor,
                    "NORMAL": normal_accessor,
                    "TEXCOORD_0": uv_accessor
                },
                "indices": index_accessor,
                "material": material_index,
                "mode": 4
            }));

            mesh_count += 1;
            vertex_count += vertices.len();
            triangle_count += index_buffer.indices.len() / 3;
        }
    }

    if primitives.is_empty() {
        bail!("O YDD foi lido, mas nenhuma geometria renderizável foi encontrada.");
    }

    align4(&mut bin, 0);

    let doc = json!({
        "asset": {
            "version": "2.0",
            "generator": "Studio K FiveM Preview"
        },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "name": entry.name, "mesh": 0 }],
        "meshes": [{
            "name": entry.name,
            "primitives": primitives
        }],
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": views,
        "accessors": accessors,
        "samplers": [{
            "magFilter": 9729,
            "minFilter": 9987,
            "wrapS": 10497,
            "wrapT": 10497
        }],
        "images": images,
        "textures": textures,
        "materials": materials,
        "extras": {
            "studioK": {
                "source": "FiveM YDD + YTD",
                "drawable": entry.name,
                "lod": lod.level.as_str()
            }
        }
    });

    let mut json_bytes = serde_json::to_vec(&doc)?;
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(b' ');
    }

    let total_length = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut glb = Vec::with_capacity(total_length);
    glb.extend_from_slice(&0x46546C67u32.to_le_bytes()); // glTF
    glb.extend_from_slice(&2u32.to_le_bytes());
    glb.extend_from_slice(&(total_length as u32).to_le_bytes());
    glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    glb.extend_from_slice(&0x4E4F534Au32.to_le_bytes()); // JSON
    glb.extend_from_slice(&json_bytes);
    glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    glb.extend_from_slice(&0x004E4942u32.to_le_bytes()); // BIN
    glb.extend_from_slice(&bin);

    let stats = json!({
        "drawables": entries.len(),
        "drawableName": entry.name,
        "lod": lod.level.as_str(),
        "meshes": mesh_count,
        "vertices": vertex_count,
        "triangles": triangle_count,
        "textures": external_textures.len(),
        "materials": materials.len()
    });

    Ok((glb, stats))
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        bail!("Uso: studio-k-fivem-preview <arquivo.ydd> <arquivo.ytd> <saida.glb>");
    }

    let ydd_path = Path::new(&args[1]);
    let ytd_path = Path::new(&args[2]);
    let out_path = Path::new(&args[3]);

    let ydd = fs::read(ydd_path).with_context(|| format!("Falha ao ler {}", ydd_path.display()))?;
    let ytd = fs::read(ytd_path).with_context(|| format!("Falha ao ler {}", ytd_path.display()))?;
    let (glb, stats) = build_preview(&ydd, &ytd)?;
    fs::write(out_path, glb).with_context(|| format!("Falha ao escrever {}", out_path.display()))?;
    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}
