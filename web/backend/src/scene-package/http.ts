import type { IncomingMessage, ServerResponse } from 'node:http';
import { SCENE_PACKAGE_LIMITS } from '@woohaa3/contracts';
import type { ScenePackageService } from './service.js';
const PREFIX = '/api/scene-packages';
export function createScenePackageHandler(service: ScenePackageService | null) {
    let uploads = 0;
    return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(req.url ?? '/', 'http://local');
        if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/'))
            return false;
        const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
        if (!service) {
            send(503, { code: 'scene-package-unavailable', message: '当前工作区不支持本地场景导入' });
            return true;
        }
        try {
            if (url.pathname === PREFIX && req.method === 'GET') {
                send(200, { available: true });
                return true;
            }
            if (url.pathname === PREFIX && req.method === 'POST') {
                const id = req.headers['x-woohaa-import-id'];
                if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
                    send(400, { code: 'invalid-operation-id', message: '导入请求标识无效' });
                    return true;
                }
                if (uploads >= 2 || !service.canAcceptUpload(uploads)) {
                    send(429, { code: 'package-import-busy', message: '已有场景正在导入，请稍后重试' });
                    return true;
                }
                uploads++;
                try {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > SCENE_PACKAGE_LIMITS.compressedBytes) {
                            send(413, { code: 'package-too-large', message: '场景文件超过大小限制' });
                            return true;
                        }
                        chunks.push(Buffer.from(chunk));
                    }
                    const result = await service.start(id, Buffer.concat(chunks), url.searchParams.get('copy') === '1');
                    send(202, result);
                    return true;
                }
                finally {
                    uploads--;
                }
            }
            const job = /^\/api\/scene-packages\/jobs\/([a-zA-Z0-9_-]{1,80})(\/cancel)?$/.exec(url.pathname);
            if (job && req.method === 'GET' && !job[2]) {
                send(200, { job: service.get(job[1]) });
                return true;
            }
            if (job && req.method === 'POST' && job[2]) {
                send(200, { job: service.cancel(job[1]) });
                return true;
            }
            const canvas = /^\/api\/scene-packages\/canvases\/([a-zA-Z0-9_-]{1,100})(\/reset)?$/.exec(url.pathname);
            if (canvas && req.method === 'GET' && !canvas[2]) {
                const receipt = service.receipt(canvas[1]);
                send(receipt ? 200 : 404, receipt ? { receipt } : { code: 'package-receipt-not-found', message: '此画布不是已导入的测试场景' });
                return true;
            }
            if (canvas && req.method === 'POST' && canvas[2]) {
                const id = req.headers['x-woohaa-import-id'];
                if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
                    send(400, { code: 'invalid-operation-id', message: '重置请求标识无效' });
                    return true;
                }
                if (uploads >= 2 || !service.canAcceptUpload(uploads)) {
                    send(429, { code: 'package-import-busy', message: '已有场景正在导入，请稍后重试' });
                    return true;
                }
                uploads++;
                try {
                    send(202, await service.reset(canvas[1], id));
                    return true;
                }
                finally {
                    uploads--;
                }
            }
            send(405, { code: 'unsupported-package-operation', message: '不支持的场景操作' });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '';
            const missing = /not-found|ENOENT/.test(message), conflict = /conflict|busy|deleted/.test(message);
            send(missing ? 404 : conflict ? 409 : 400, { code: missing ? 'scene-package-not-found' : conflict ? 'scene-package-conflict' : 'scene-package-failed', message: missing ? '场景源文件或作业不存在，请重新选择文件' : conflict ? '导入请求冲突或正在处理，请稍后重试' : '场景操作失败，请检查文件或重试' });
        }
        return true;
    };
}
