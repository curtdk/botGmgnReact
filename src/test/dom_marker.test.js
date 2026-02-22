import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import FlowerMarker from '../content/FlowerMarker';

describe('FlowerMarker Logic', () => {
    let flowerMarker;
    let container;

    beforeEach(() => {
        // 创建模拟的 DOM 环境
        container = document.createElement('div');
        document.body.appendChild(container);
        flowerMarker = new FlowerMarker();
        flowerMarker.setEnabled(true);
    });

    it('should inject icon into the row container when available', () => {
        // Create Row Structure
        const row = document.createElement('div');
        row.className = 'flex flex-row relative';
        container.appendChild(row);

        // Add some cells and the link inside the row
        const cell = document.createElement('div');
        row.appendChild(cell);

        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserRow';
        link.textContent = 'UserRow';
        cell.appendChild(link);

        const dataMap = new Map();
        dataMap.set('UserRow', { status: '散户' });

        flowerMarker.mark(dataMap);

        // Expectation: Icon should be direct child of ROW, not LINK
        const iconInRow = row.querySelector(':scope > .gmgn-flower-icon');
        expect(iconInRow).not.toBeNull();
        expect(iconInRow.textContent).toBe('🌸');
        
        // Verify styling for row injection
        expect(iconInRow.style.left).toBe('4px');
        
        // Link should still be marked to prevent reprocessing
        expect(link.dataset.gmgnMarked).toBe('true');
    });

    it('should fallback to link injection if row not found', () => {
        // Standalone link (no row parent)
        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserFallback';
        link.textContent = 'UserFallback';
        container.appendChild(link);

        const dataMap = new Map();
        dataMap.set('UserFallback', { status: '散户' });

        flowerMarker.mark(dataMap);

        // Expectation: Icon inside LINK
        const iconInLink = link.querySelector('.gmgn-flower-icon');
        expect(iconInLink).not.toBeNull();
        expect(iconInLink.style.left).toBe('-90px');
    });

    afterEach(() => {
        document.body.removeChild(container);
        flowerMarker = null;
    });

    it('should use fire icons based on thresholds for retail users', () => {
        // Create Row Structure
        const row = document.createElement('div');
        row.className = 'flex flex-row relative';
        container.appendChild(row);

        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserFire';
        link.textContent = 'UserFire';
        row.appendChild(link);

        const dataMap = new Map();
        // Retail user with high buy amount
        dataMap.set('UserFire', { 
            status: '散户', 
            total_buy_u: 250 // Should be 2 fires (thresholds: 100, 200, 300)
        });

        const config = { fire_thresholds: [100, 200, 300] };
        flowerMarker.mark(dataMap, config);

        const icon = row.querySelector('.gmgn-flower-icon');
        expect(icon).not.toBeNull();
        // Now includes flower + fire
        expect(icon.textContent).toBe('🌸 🔥🔥');
        
        // Verify styling
        expect(icon.style.position).toBe('absolute');
        expect(icon.style.left).toBe('4px');
        expect(icon.style.zIndex).toBe('100');
    });

    it('should show 3 fires for very high amount', () => {
        const row = document.createElement('div');
        row.className = 'flex flex-row relative';
        container.appendChild(row);

        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserFire3';
        link.textContent = 'UserFire3';
        row.appendChild(link);

        const dataMap = new Map();
        dataMap.set('UserFire3', { status: '散户', total_buy_u: 500 });

        flowerMarker.mark(dataMap, { fire_thresholds: [100, 200, 300] });
        expect(row.querySelector('.gmgn-flower-icon').textContent).toBe('🌸 🔥🔥🔥');
    });

    it('should show default flower for retail user with low amount', () => {
        const row = document.createElement('div');
        row.className = 'flex flex-row relative';
        container.appendChild(row);

        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserLow';
        link.textContent = 'UserLow';
        row.appendChild(link);

        const dataMap = new Map();
        dataMap.set('UserLow', { status: '散户', total_buy_u: 50 });

        flowerMarker.mark(dataMap, { fire_thresholds: [100, 200, 300] });
        expect(row.querySelector('.gmgn-flower-icon').textContent).toBe('🌸');
    });

    it('should NOT show any icon for Boss even if high amount', () => {
        const row = document.createElement('div');
        row.className = 'flex flex-row relative';
        container.appendChild(row);

        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserBossNoIcon';
        link.textContent = 'UserBossNoIcon';
        row.appendChild(link);

        const dataMap = new Map();
        dataMap.set('UserBossNoIcon', { status: '庄家', total_buy_u: 1000 });

        flowerMarker.mark(dataMap, { fire_thresholds: [100, 200, 300] });
        expect(row.querySelector('.gmgn-flower-icon')).toBeNull();
    });

    it('should skip links with no text (e.g. avatars)', () => {
        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserEmpty';
        link.textContent = '   '; // Empty or whitespace
        container.appendChild(link);

        const dataMap = new Map();
        dataMap.set('UserEmpty', { status: '散户' }); 

        flowerMarker.mark(dataMap);

        expect(link.querySelector('.gmgn-flower-icon')).toBeNull();
    });

    it('should prevent duplicates using WeakSet even if dataset is removed', () => {
        const row = document.createElement('div');
        row.className = 'flex flex-row relative';
        container.appendChild(row);

        const link = document.createElement('a');
        link.href = 'https://gmgn.ai/sol/address/UserWeakSet';
        link.textContent = 'UserWeakSet';
        row.appendChild(link);

        const dataMap = new Map();
        dataMap.set('UserWeakSet', { status: '散户' }); 

        // First Mark
        flowerMarker.mark(dataMap);
        expect(row.querySelector('.gmgn-flower-icon')).not.toBeNull();

        // Simulate dataset removal (e.g. some other script)
        delete link.dataset.gmgnMarked;

        // Second Mark
        flowerMarker.mark(dataMap);
        
        // Should still have only 1 icon because of WeakSet (link already processed) OR Row check (row already has icon)
        expect(row.querySelectorAll('.gmgn-flower-icon').length).toBe(1);
    });

    it('should avoid duplicate markers on nested container links (Real World Repro)', () => {
        // Simulate structure: Row -> Outer Link -> Inner Link
        // We expect ONE icon on the Row.
        const rowHTML = `
        <div class="relative py-1px">
            <div class="flex flex-row" id="targetRow">
                <!-- Outer Container Link -->
                <div class="flex items-center" style="justify-content: right;">
                    <a data-sentry-element="Link" target="_blank" class="flex flex-shrink items-center gap-[2px]" href="/sol/address/G8Jg7JG7h59bvsuPi57GuRS4mZ1S99PUbp4JLNCJgcWF">
                        <svg width="12px" height="12px"></svg>
                        <div class="flex items-center gap-[4px]">
                             <!-- Inner Content -->
                             <div>
                                 <div class="flex items-center gap-[8px]">
                                     <div class="flex flex-shrink items-center gap-[2px]">
                                         <!-- Inner Text Link -->
                                         <div class="flex" style="justify-content: flex-end;">
                                             <a target="_blank" class="flex-shrink" href="/sol/address/G8Jg7JG7h59bvsuPi57GuRS4mZ1S99PUbp4JLNCJgcWF">
                                                 <div class="truncate w-full items-center font-medium">G8Jg...gcWF</div>
                                             </a>
                                         </div>
                                     </div>
                                 </div>
                             </div>
                        </div>
                    </a>
                </div>
            </div>
        </div>
        `;
        
        container.innerHTML = rowHTML;
        
        const dataMap = new Map();
         dataMap.set('G8Jg7JG7h59bvsuPi57GuRS4mZ1S99PUbp4JLNCJgcWF', { status: '散户', score: 100 });
 
         flowerMarker.mark(dataMap);

        // Expectation:
        // 1. Total icons = 1
        // 2. Icon is on the Row (id="targetRow")

        const row = container.querySelector('#targetRow');
        const icons = row.querySelectorAll(':scope > .gmgn-flower-icon');
        expect(icons.length).toBe(1);
        expect(icons[0].textContent).toBe('🌸');
        expect(icons[0].style.left).toBe('4px');
        
        // Both links might be marked in dataset to prevent re-scan, but visually only one icon appears on row
        // The first link encountered (outer or inner) that finds the row will trigger the row injection.
        // Subsequent links finding the same row will see the row already has an icon and skip.
    });
});
