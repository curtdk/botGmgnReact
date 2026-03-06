export const THEMES = {
    dark: {
        bg: '#0b0b0c',
        panelBg: '#0b0b0c',
        text: '#ddd',
        textSecondary: '#9ca3af',
        textHighlight: '#e5e7eb',
        border: '#2a2a2e',
        headerBg: '#111827',
        subHeaderBg: '#1f2937',
        hoverBg: '#374151',
        selectedBg: '#374151',
        buttonBg: '#222',
        buttonBorder: '#444',
        buttonText: '#ddd',
        inputBg: '#374151',
        inputText: '#d1d5db',
        bossColor: '#f59e0b',
        retailColor: '#3b82f6',
        successColor: '#10b981',
        shadow: '0 8px 24px rgba(0,0,0,.35)',
        scrollTrack: '#1f2937',
        scrollThumb: '#6b7280',
        scrollThumbHover: '#9ca3af'
    },
    light: {
        bg: '#ffffff',
        panelBg: '#ffffff',
        text: '#111827',
        textSecondary: '#4b5563',
        textHighlight: '#1f2937',
        border: '#e5e7eb',
        headerBg: '#f3f4f6',
        subHeaderBg: '#e5e7eb',
        hoverBg: '#f3f4f6',
        selectedBg: '#e5e7eb',
        buttonBg: '#fff',
        buttonBorder: '#d1d5db',
        buttonText: '#374151',
        inputBg: '#fff',
        inputText: '#111827',
        bossColor: '#d97706', // Slightly darker for light mode visibility
        retailColor: '#2563eb',
        successColor: '#059669',
        shadow: '0 8px 24px rgba(0,0,0,.15)',
        scrollTrack: '#f3f4f6',
        scrollThumb: '#d1d5db',
        scrollThumbHover: '#9ca3af'
    }
};

export const getStyles = (theme, isOpen, width, listFontSize, userListHeight = 120) => {
    return {
        container: {
            position: 'fixed',
            right: 0,
            top: 0,
            height: '100vh',
            width: isOpen ? `${width}px` : '24px',
            backgroundColor: theme.panelBg,
            color: theme.text,
            borderLeft: `1px solid ${theme.border}`,
            boxShadow: theme.shadow,
            zIndex: 2147483646,
            display: 'flex',
            flexDirection: 'column',
            transition: 'width 0s', // 拖拽时禁用过渡动画以保证跟手
            fontSize: '12px'
        },
        resizer: {
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '10px',
            cursor: 'col-resize',
            zIndex: 100,
            transform: 'translateX(-5px)', // 居中于边缘
            backgroundColor: 'transparent'
        },
        header: {
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '8px',
            borderBottom: `1px solid ${theme.border}`,
            background: theme.headerBg,
            flexWrap: 'wrap'
        },
        statusLogs: {
            padding: '5px 10px',
            color: theme.textSecondary,
            fontSize: '11px',
            maxHeight: '120px',
            overflowY: 'auto',
            borderBottom: `1px solid ${theme.border}`
        },
        shortNamesContainer: {
            padding: '5px 10px',
            borderBottom: `1px solid ${theme.border}`,
            background: theme.subHeaderBg,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            maxHeight: '80px',
            overflowY: 'auto'
        },
        shortNameLabel: {
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            color: theme.textHighlight,
            cursor: 'pointer',
            background: theme.hoverBg,
            padding: '2px 6px',
            borderRadius: '4px'
        },
        summary: {
            padding: '10px',
            borderBottom: `1px solid ${theme.border}`
        },
        filterBar: {
            padding: '8px',
            background: theme.headerBg,
            display: 'flex',
            gap: '12px',
            alignItems: 'center',
            flexWrap: 'wrap'
        },
        colSettingsBtn: {
            background: 'transparent',
            border: 'none',
            color: theme.textSecondary,
            cursor: 'pointer',
            fontSize: '11px',
            display: 'flex',
            alignItems: 'center',
            gap: '2px'
        },
        colSettingsPanel: {
            position: 'absolute',
            right: 0,
            top: '100%',
            background: theme.subHeaderBg,
            border: `1px solid ${theme.border}`,
            padding: '8px',
            borderRadius: '4px',
            zIndex: 10,
            width: '200px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            boxShadow: theme.shadow
        },
        listHeader: {
            display: 'flex',
            padding: '6px 8px',
            background: theme.subHeaderBg,
            color: theme.textSecondary,
            fontWeight: 600
        },
        listContent: {
            flex: 1,
            maxHeight: `${userListHeight}px`,
            overflowY: 'auto'
        },
        listItem: (isSelected) => ({
            display: 'flex',
            padding: '4px 8px',
            borderBottom: `1px solid ${theme.border}`,
            alignItems: 'center',
            cursor: 'pointer',
            background: isSelected ? theme.selectedBg : 'transparent',
            fontSize: `${listFontSize}px`,
            color: theme.text
        }),
        detailView: {
            padding: '10px',
            borderTop: `1px solid ${theme.border}`,
            height: '150px',
            overflowY: 'auto',
            background: theme.headerBg,
            fontSize: '11px',
            color: theme.textSecondary
        },
        footer: {
            padding: '6px 10px',
            borderTop: `1px solid ${theme.border}`,
            background: theme.panelBg,
            fontSize: '11px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
        },
        debugInfo: {
            padding: '8px',
            background: '#000', // Keep debug black/terminal-like
            borderTop: `1px solid ${theme.border}`,
            fontSize: '10px',
            color: '#6b7280',
            whiteSpace: 'pre-wrap'
        },
        smBtn: {
            background: theme.buttonBg,
            color: theme.buttonText,
            border: `1px solid ${theme.buttonBorder}`,
            borderRadius: '4px',
            padding: '2px 4px',
            fontSize: '11px',
            cursor: 'pointer'
        },
        input: {
            background: theme.inputBg,
            border: 'none',
            color: theme.inputText,
            fontSize: '10px',
            padding: '1px 2px',
            borderRadius: '2px',
            textAlign: 'center'
        },
        // Helper colors
        colors: {
            boss: theme.bossColor,
            retail: theme.retailColor,
            success: theme.successColor,
            textSecondary: theme.textSecondary,
            textHighlight: theme.textHighlight
        }
    };
};
