// File-backed storage. Layout under the data directory:
//   docs/<docId>/doc.json            current document
//   docs/<docId>/history.jsonl       one line of metadata per revision
//   docs/<docId>/revs/<rev>.json.gz  full snapshot per revision (for review, diff and restore)
//   docs/<docId>/comments.json       comment threads
//   assets/<sha256>.<ext>            uploaded images
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { newId, type EaselDoc } from '../shared/model.ts';

export interface RevisionMeta { rev: number; author: string; message: string; time: string; changed: string[] }
export interface CommentReply { id: string; author: string; text: string; time: string }
export interface Comment {
  id: string; pageId: string; nodeId?: string; x: number; y: number;
  author: string; text: string; time: string; resolved: boolean; replies: CommentReply[];
}
export interface ChangeEvent { type: 'doc' | 'comments' | 'docs'; docId?: string; rev?: number; author?: string; message?: string; changed?: string[] }

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const DOC_ID = /^d_[a-z0-9]{6,32}$/;
const ASSET_ID = /^a_[a-f0-9]{64}\.(png|jpg|gif|webp|svg)$/;

function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class Store extends EventEmitter {
  private cache = new Map<string, EaselDoc>();
  constructor(public dir: string) {
    super();
    this.setMaxListeners(1000);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  }

  private docDir(id: string) {
    if (!DOC_ID.test(id)) throw new Error(`invalid document id "${id}"`);
    return path.join(this.dir, 'docs', id);
  }

  listDocs(): { id: string; name: string; updated: string; rev: number; pages: { id: string; name: string; frames: { id: string; name?: string }[] }[] }[] {
    const ids = fs.readdirSync(path.join(this.dir, 'docs')).filter((d) => DOC_ID.test(d) && fs.existsSync(path.join(this.dir, 'docs', d, 'doc.json')));
    return ids.map((id) => this.getDoc(id)).map((d) => ({
      id: d.id, name: d.name, updated: d.updated, rev: d.rev,
      pages: d.pages.map((p) => ({ id: p.id, name: p.name, frames: p.children.map((n) => ({ id: n.id, name: n.name })) })),
    })).sort((a, b) => b.updated.localeCompare(a.updated));
  }

  exists(id: string): boolean {
    return DOC_ID.test(id) && fs.existsSync(path.join(this.docDir(id), 'doc.json'));
  }

  getDoc(id: string): EaselDoc {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const file = path.join(this.docDir(id), 'doc.json');
    if (!fs.existsSync(file)) throw new Error(`document "${id}" not found`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as EaselDoc;
    this.cache.set(id, doc);
    return doc;
  }

  createDoc(name: string, author: string): EaselDoc {
    const now = new Date().toISOString();
    const doc: EaselDoc = { id: newId('d'), name: name.slice(0, 200) || 'Untitled', created: now, updated: now, rev: 0, pages: [{ id: newId('p'), name: 'Page 1', children: [] }] };
    fs.mkdirSync(path.join(this.docDir(doc.id), 'revs'), { recursive: true });
    this.commit(doc, { author, message: 'Created document', changed: [] }, true);
    this.emit('change', { type: 'docs' } satisfies ChangeEvent);
    return this.getDoc(doc.id);
  }

  deleteDoc(id: string) {
    const dir = this.docDir(id);
    if (!fs.existsSync(dir)) throw new Error(`document "${id}" not found`);
    // keep deleted documents recoverable instead of removing them
    const trash = path.join(this.dir, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dir, path.join(trash, `${id}-${Date.now()}`));
    this.cache.delete(id);
    this.emit('change', { type: 'docs' } satisfies ChangeEvent);
  }

  /** Saves next as the new current version and records a revision. */
  commit(next: EaselDoc, meta: { author: string; message: string; changed: string[] }, initial = false): RevisionMeta {
    const dir = this.docDir(next.id);
    const prev = initial ? null : this.getDoc(next.id);
    const doc: EaselDoc = { ...next, rev: (prev?.rev ?? -1) + 1, updated: new Date().toISOString() };
    const rev: RevisionMeta = { rev: doc.rev, author: meta.author, message: meta.message.slice(0, 500) || 'Edit', time: doc.updated, changed: meta.changed.slice(0, 2000) };
    const json = JSON.stringify(doc);
    fs.writeFileSync(path.join(dir, 'revs', `${doc.rev}.json.gz`), zlib.gzipSync(json));
    fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(rev) + '\n');
    writeAtomic(path.join(dir, 'doc.json'), json);
    this.cache.set(doc.id, doc);
    if (!initial) this.emit('change', { type: 'doc', docId: doc.id, rev: doc.rev, author: rev.author, message: rev.message, changed: rev.changed } satisfies ChangeEvent);
    return rev;
  }

  history(id: string, limit = 50, before?: number): RevisionMeta[] {
    const file = path.join(this.docDir(id), 'history.jsonl');
    const all = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RevisionMeta);
    const list = before === undefined ? all : all.filter((r) => r.rev < before);
    return list.slice(-limit).reverse();
  }

  getRevision(id: string, rev: number): EaselDoc {
    if (!Number.isInteger(rev) || rev < 0) throw new Error('invalid revision');
    const file = path.join(this.docDir(id), 'revs', `${rev}.json.gz`);
    if (!fs.existsSync(file)) throw new Error(`revision ${rev} of "${id}" not found`);
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  }

  restore(id: string, rev: number, author: string): RevisionMeta {
    const old = this.getRevision(id, rev);
    const cur = this.getDoc(id);
    return this.commit({ ...old, id: cur.id, created: cur.created }, { author, message: `Restored revision ${rev}`, changed: [] });
  }

  comments(id: string): Comment[] {
    const file = path.join(this.docDir(id), 'comments.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  }

  saveComments(id: string, list: Comment[]) {
    writeAtomic(path.join(this.docDir(id), 'comments.json'), JSON.stringify(list, null, 1));
    this.emit('change', { type: 'comments', docId: id } satisfies ChangeEvent);
  }

  putAsset(buf: Buffer, mime: string): string {
    const ext = MIME_EXT[mime];
    if (!ext) throw new Error(`unsupported image type ${mime}; use png, jpeg, gif, webp or svg`);
    if (buf.length > 15 * 1024 * 1024) throw new Error('image larger than 15 MB');
    const id = `a_${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`;
    const file = path.join(this.dir, 'assets', id);
    if (!fs.existsSync(file)) writeAtomic(file, buf);
    return id;
  }

  getAsset(id: string): { buf: Buffer; mime: string } | null {
    if (!ASSET_ID.test(id)) return null;
    const file = path.join(this.dir, 'assets', id);
    if (!fs.existsSync(file)) return null;
    const ext = id.split('.').pop()!;
    const mime = Object.entries(MIME_EXT).find(([, e]) => e === ext)![0];
    return { buf: fs.readFileSync(file), mime };
  }

  fontFiles(): string[] {
    const d = path.join(this.dir, 'fonts');
    return fs.readdirSync(d).filter((f) => /\.(ttf|otf|ttc)$/i.test(f)).map((f) => path.join(d, f));
  }
}

export function isAssetId(s: string): boolean {
  return ASSET_ID.test(s);
}
