/**
 * 数据流日志系统
 * 用于追踪和验证数据来源
 */

class DataFlowLogger {
  constructor() {
    this.logs = [];
    this.enabled = false;
    this.maxLogs = 1000; // 最多保存 1000 条日志

    // 从 storage 加载开关状态
    this.loadSettings();
  }

  /**
   * 加载日志设置
   */
  async loadSettings() {
    try {
      const result = await chrome.storage.local.get('data_flow_logger_enabled');
      this.enabled = result.data_flow_logger_enabled || false;
      console.log(`[数据流日志] 日志系统: ${this.enabled ? '启用' : '禁用'}`);
    } catch (err) {
      console.error('[数据流日志] 加载设置失败:', err);
    }
  }

  /**
   * 设置日志开关
   */
  async setEnabled(enabled) {
    this.enabled = enabled;
    try {
      await chrome.storage.local.set({ data_flow_logger_enabled: enabled });
      console.log(`[数据流日志] 日志系统: ${enabled ? '启用' : '禁用'}`);

      if (enabled) {
        this.log('系统', '日志启用', '数据流日志系统已启用');
      }
    } catch (err) {
      console.error('[数据流日志] 保存设置失败:', err);
    }
  }

  /**
   * 记录日志
   * @param {string} source - 来源（HeliusMonitor, contentManager, etc.）
   * @param {string} event - 事件类型
   * @param {string} details - 详细信息
   * @param {object} data - 附加数据
   */
  log(source, event, details, data = null) {
    if (!this.enabled) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      time: new Date().toLocaleTimeString('zh-CN'),
      source,
      event,
      details,
      data
    };

    this.logs.push(logEntry);

    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // 输出到控制台（带颜色）
    const colors = {
      'HeliusMonitor': '#10b981',
      'HeliusIntegration': '#3b82f6',
      'contentManager': '#f59e0b',
      'hook.js': '#8b5cf6',
      '系统': '#6b7280'
    };

    const color = colors[source] || '#ffffff';
    console.log(
      `%c[数据流日志] ${logEntry.time} [${source}] ${event}`,
      `color: ${color}; font-weight: bold`,
      details,
      data || ''
    );
  }

  /**
   * 获取所有日志
   */
  getLogs() {
    return this.logs;
  }

  /**
   * 清空日志
   */
  clear() {
    this.logs = [];
    console.log('[数据流日志] 日志已清空');
  }

  /**
   * 导出日志为文本
   */
  exportAsText() {
    if (this.logs.length === 0) {
      return '暂无日志记录';
    }

    let text = '='.repeat(80) + '\n';
    text += '数据流日志\n';
    text += `导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
    text += `日志条数: ${this.logs.length}\n`;
    text += '='.repeat(80) + '\n\n';

    this.logs.forEach((log, index) => {
      text += `[${index + 1}] ${log.time} [${log.source}] ${log.event}\n`;
      text += `    ${log.details}\n`;
      if (log.data) {
        text += `    数据: ${JSON.stringify(log.data, null, 2)}\n`;
      }
      text += '\n';
    });

    return text;
  }

  /**
   * 下载日志文件
   */
  downloadLogs() {
    const text = this.exportAsText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `数据流日志_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const stats = {
      total: this.logs.length,
      bySources: {},
      byEvents: {}
    };

    this.logs.forEach(log => {
      // 按来源统计
      if (!stats.bySources[log.source]) {
        stats.bySources[log.source] = 0;
      }
      stats.bySources[log.source]++;

      // 按事件统计
      if (!stats.byEvents[log.event]) {
        stats.byEvents[log.event] = 0;
      }
      stats.byEvents[log.event]++;
    });

    return stats;
  }
}

// 创建全局实例
const dataFlowLogger = new DataFlowLogger();

// 暴露到 window 以便调试
if (typeof window !== 'undefined') {
  window.__dataFlowLogger = dataFlowLogger;
}

export default dataFlowLogger;
