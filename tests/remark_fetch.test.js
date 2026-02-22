
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 模拟 ContentScoreManager
class MockContentScoreManager {
    constructor() {
        this.shortAddressMap = {};
    }
    setShortAddress(address, remark) {
        this.shortAddressMap[address] = remark;
    }
    // [新增] 模拟批量更新
    updateShortAddresses(items) {
        let count = 0;
        items.forEach(item => {
            if (this.shortAddressMap[item.address] !== item.remark) {
                this.shortAddressMap[item.address] = item.remark;
                count++;
            }
        });
        return count;
    }
    getSortedItems() {
        return [];
    }
}

// 模拟 fetchFullRemarks 逻辑 (复制自 src/content/index.jsx 并简化)
async function fetchFullRemarks(initialUrl, contentManager, safeSendMessage, headers = {}) {
    let count = 0;
    let page = 0;
    let nextCursor = ''; 
    let currentUrl = initialUrl;

    // 模拟 window.location.origin
    const origin = 'https://gmgn.ai';

    try {
        const tempUrl = new URL(currentUrl, origin);
        tempUrl.searchParams.set('limit', '50');
        currentUrl = tempUrl.pathname + tempUrl.search;
    } catch (e) {}

    try {
        do {
            page++;
            if (nextCursor) {
                const u = new URL(currentUrl, origin);
                u.searchParams.set('cursor', nextCursor);
                currentUrl = u.pathname + u.search;
            }

            console.log(`[GMGN Content] Fetching remarks page ${page}...`, currentUrl);

            const res = await global.fetch(currentUrl, {
                headers: headers
            });
            const json = await res.json();

            if (json.code !== 0 || !json.data) break;

            const list = json.data.remark_info || [];
            nextCursor = json.data.cursor;

            if (list.length > 0) {
                // 使用 updateShortAddresses
                const updates = list.map(item => ({
                    address: item.address,
                    remark: item.remark
                })).filter(item => item.address && item.remark);
                
                const updatedCount = contentManager.updateShortAddresses(updates);
                count += updatedCount;
                
                safeSendMessage({
                    type: 'LOG',
                    message: `正在同步备注: 第 ${page} 页，本页新增/更新 ${updatedCount} 条...`,
                    level: 'info'
                });
            } else {
                break;
            }

        } while (nextCursor);

        safeSendMessage({
            type: 'LOG',
            message: `GMGN 备注同步完成！共更新 ${count} 条数据`,
            level: 'success'
        });

    } catch (err) {
        safeSendMessage({ type: 'LOG', message: err.message, level: 'error' });
    }
}

describe('Remark Fetching Logic', () => {
    let contentManager;
    let safeSendMessage;

    beforeEach(() => {
        contentManager = new MockContentScoreManager();
        safeSendMessage = vi.fn();
        
        // Mock global fetch
        global.fetch = vi.fn();
    });

    it('should fetch all pages and update content manager', async () => {
        // Mock API responses
        const page1 = {
            code: 0,
            data: {
                cursor: 'cursor_page_2',
                remark_info: [
                    { address: 'ADDR1', remark: 'Remark 1' },
                    { address: 'ADDR2', remark: 'Remark 2' }
                ]
            }
        };

        const page2 = {
            code: 0,
            data: {
                cursor: '', // End of pages
                remark_info: [
                    { address: 'ADDR3', remark: 'Remark 3' }
                ]
            }
        };

        global.fetch
            .mockResolvedValueOnce({ json: () => Promise.resolve(page1) })
            .mockResolvedValueOnce({ json: () => Promise.resolve(page2) });

        const initialUrl = 'https://gmgn.ai/api/v1/follow/get_remark_info/sol?limit=30';

        await fetchFullRemarks(initialUrl, contentManager, safeSendMessage);

        // Verify data updates
        expect(contentManager.shortAddressMap['ADDR1']).toBe('Remark 1');
        expect(contentManager.shortAddressMap['ADDR2']).toBe('Remark 2');
        expect(contentManager.shortAddressMap['ADDR3']).toBe('Remark 3');

        // Verify log messages
        expect(safeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'LOG',
            message: expect.stringContaining('第 1 页')
        }));
        expect(safeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'LOG',
            message: expect.stringContaining('第 2 页')
        }));
        expect(safeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'LOG',
            message: expect.stringContaining('共更新 3 条数据')
        }));
    });

    it('should handle empty response gracefully', async () => {
        global.fetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ code: 0, data: { remark_info: [], cursor: '' } })
        });

        await fetchFullRemarks('https://test.com', contentManager, safeSendMessage);

        expect(Object.keys(contentManager.shortAddressMap).length).toBe(0);
        expect(safeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('共更新 0 条数据')
        }));
    });

    // 新增去重测试
    it('should deduplicate and only count new updates', async () => {
        // 预设已存在的数据
        contentManager.setShortAddress('EXISTING', 'Old Remark');

        global.fetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ 
                code: 0, 
                data: { 
                    remark_info: [
                        { address: 'EXISTING', remark: 'Old Remark' }, // 重复，不应更新
                        { address: 'NEW', remark: 'New Remark' },      // 新增
                        { address: 'EXISTING', remark: 'New Value' }   // 变更 (假设 API 返回了，虽不常见)
                    ], 
                    cursor: '' 
                } 
            })
        });

        await fetchFullRemarks('https://test.com', contentManager, safeSendMessage);

        // 验证最终状态
        expect(contentManager.shortAddressMap['EXISTING']).toBe('New Value'); // 后面的覆盖前面的
        expect(contentManager.shortAddressMap['NEW']).toBe('New Remark');

        // 验证日志中的计数 (应该是 2: NEW 和 EXISTING的新值)
        // 注意：第一次 EXISTING 没变，不计数。第二次变了，计数。
        // 在批量处理中，我们是一次性传给 updateShortAddresses。
        // 如果数组中有重复 key，mock 的实现会依次处理。
        // updateShortAddresses(['EXISTING': 'Old', 'NEW': 'New', 'EXISTING': 'NewVal'])
        // 1. 'EXISTING' vs 'Old' -> Same, count=0
        // 2. 'NEW' vs undefined -> Diff, count=1
        // 3. 'EXISTING' vs 'Old' (curr) -> 'NewVal' -> Diff, count=2
        
        expect(safeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('共更新 2 条数据')
        }));
    });

    it('should handle relative URLs correctly', async () => {
        global.fetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ 
                code: 0, 
                data: { 
                    remark_info: [{ address: 'ADDR_REL', remark: 'Relative' }], 
                    cursor: '' 
                } 
            })
        });

        const relativeUrl = '/api/v1/follow/get_remark_info/sol?limit=30';
        await fetchFullRemarks(relativeUrl, contentManager, safeSendMessage);

        expect(contentManager.shortAddressMap['ADDR_REL']).toBe('Relative');
        
        // 验证 fetch 调用的是相对 URL (不包含 origin)
        expect(global.fetch).toHaveBeenCalledWith(
            expect.not.stringContaining('https://gmgn.ai'),
            expect.anything()
        );
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/v1/follow/get_remark_info/sol'),
            expect.anything()
        );
    });

    it('should pass request headers', async () => {
        global.fetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ code: 0, data: { remark_info: [], cursor: '' } })
        });

        const headers = { 'Authorization': 'Bearer test' };
        await fetchFullRemarks('/api/v1/test', contentManager, safeSendMessage, headers);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                headers: headers
            })
        );
    });
});
