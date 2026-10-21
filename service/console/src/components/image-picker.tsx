/**
 * 图片字段：从本租户的图片资源中选，或上传新图（资源接口，票据 10）。取值是资源引用 res:资源ID；
 * 编译产物允许地址时另可填 http(s) 地址。资源内容经开放 API 读成 blob 再显示，接口进程不按图片类型回答它。
 * 表格的单元格里是缩略按钮，点开是同样的选图面板。
 */
import { useEffect, useState } from 'react';
import { api, imageBlob } from '../api.js';
import { problemsOf } from '../hooks.js';
import type { Problem, ResourceInfo } from '../types.js';
import { ErrorBox } from './problems.js';

let resources: Promise<ResourceInfo[]> | undefined;
const thumbnails = new Map<string, Promise<string>>();

/** 本租户的图片资源；上传之后重新读。 */
function imageResources(): Promise<ResourceInfo[]> {
  resources ??= api.resources().then((reply) => reply.resources.filter((resource) => resource.kind === 'image'), (error: unknown) => {
    resources = undefined;
    throw error;
  });
  return resources;
}

function thumbnail(resource: ResourceInfo): Promise<string> {
  const key = `${resource.id}@${resource.currentVersion}`;
  let url = thumbnails.get(key);
  if (!url) {
    url = api.resourceBytes(resource.id, resource.currentVersion).then((bytes) => URL.createObjectURL(imageBlob(bytes)));
    url.catch(() => thumbnails.delete(key));
    thumbnails.set(key, url);
  }
  return url;
}

export function ResourceThumb(props: { readonly id: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    imageResources().then((list) => {
      const found = list.find((resource) => resource.id === props.id);
      return found ? thumbnail(found) : undefined;
    }).then((value) => { if (live) setUrl(value); }, () => { if (live) setUrl(undefined); });
    return () => { live = false; };
  }, [props.id]);
  return url ? <img className="thumb" src={url} alt={props.id} /> : <span className="thumb thumb-missing" aria-hidden="true" />;
}

const RESOURCE = /^res:([A-Za-z0-9][A-Za-z0-9_-]*)$/;

interface ChoiceProps {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly onChange: (value: string | undefined) => void;
  readonly sources?: readonly ('resource' | 'url')[];
  readonly allowUpload?: boolean;
  readonly invalid?: boolean;
  /** 单元格里：缩略按钮加弹出的选图面板。 */
  readonly compact?: boolean;
}

/** 选图面板：资源网格、上传新图、清除。 */
function Picker(props: ChoiceProps & { readonly onDone: () => void }) {
  const sources = props.sources ?? ['resource'];
  const [list, setList] = useState<ResourceInfo[]>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<readonly Problem[]>();
  const resourceId = props.value ? RESOURCE.exec(props.value)?.[1] : undefined;

  useEffect(() => {
    let live = true;
    imageResources().then((value) => { if (live) setList(value); }, (error: unknown) => { if (live) setFailed(problemsOf(error)); });
    return () => { live = false; };
  }, []);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailed(undefined);
    try {
      const created = await api.uploadImage(file);
      resources = undefined;
      props.onChange(`res:${created.id}`);
      props.onDone();
    } catch (error) { setFailed(problemsOf(error)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="resource-grid" role="listbox" aria-label={`${props.label}可选的图片资源`}>
        {list === undefined && !failed && <span className="muted">正在读取资源…</span>}
        {list?.length === 0 && <span className="muted">本租户还没有图片资源，可以上传新图片。</span>}
        {list?.map((resource) => (
          <button type="button" role="option" key={resource.id} aria-selected={resource.id === resourceId} className="resource-option quiet"
            onClick={() => { props.onChange(`res:${resource.id}`); props.onDone(); }}>
            <ResourceThumb id={resource.id} />
            <span>{resource.id}</span>
          </button>
        ))}
      </div>
      <div className="image-actions">
        {props.allowUpload !== false && (
          <label className="button small quiet">
            {busy ? '上传中…' : '上传新图片'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="visually-hidden" aria-label={`上传${props.label}的新图片`}
              disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
          </label>
        )}
        {props.compact && sources.includes('url') && (
          <input type="text" aria-label={`${props.label}的地址`} value={props.value ?? ''} placeholder="https:// 地址"
            onChange={(event) => props.onChange(event.target.value === '' ? undefined : event.target.value)} />
        )}
        {props.value !== undefined && <button type="button" className="link" onClick={() => { props.onChange(undefined); props.onDone(); }}>清除</button>}
      </div>
      <ErrorBox problems={failed} />
    </>
  );
}

export function ImageChoice(props: ChoiceProps) {
  const sources = props.sources ?? ['resource'];
  const [open, setOpen] = useState(false);
  const resourceId = props.value ? RESOURCE.exec(props.value)?.[1] : undefined;

  if (props.compact) {
    return (
      <div className={`image-choice${props.invalid ? ' invalid' : ''}`}>
        <button type="button" id={props.id} className={`thumb-button${props.value ? '' : ' empty'}`} aria-expanded={open}
          aria-invalid={props.invalid || undefined} aria-label={`${props.label}：${props.value ?? '未选图片'}`} onClick={() => setOpen(!open)}>
          {resourceId ? <ResourceThumb id={resourceId} /> : props.value ? '链接' : '+'}
        </button>
        {open && (
          <div className="popover" role="dialog" aria-label={`选择${props.label}`}>
            <Picker {...props} onDone={() => setOpen(false)} />
            <button type="button" className="small quiet" onClick={() => setOpen(false)}>关闭</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`image-choice${props.invalid ? ' invalid' : ''}`}>
      <div className="image-current">
        {resourceId ? <ResourceThumb id={resourceId} /> : <span className="thumb thumb-missing" aria-hidden="true" />}
        {sources.includes('url') ? (
          <input id={props.id} type="text" value={props.value ?? ''} placeholder={sources.includes('resource') ? 'res:资源ID 或 https:// 地址' : 'https:// 地址'}
            onChange={(event) => props.onChange(event.target.value === '' ? undefined : event.target.value)} />
        ) : (
          <output id={props.id} className="image-value">{props.value ?? '未选图片'}</output>
        )}
        {sources.includes('resource') && (
          <button type="button" className="small quiet" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起资源' : `从资源中选${props.label}`}</button>
        )}
      </div>
      {open && <Picker {...props} onDone={() => setOpen(false)} />}
      {!open && props.value !== undefined && <div className="image-actions"><button type="button" className="link" onClick={() => props.onChange(undefined)}>清除</button></div>}
    </div>
  );
}
