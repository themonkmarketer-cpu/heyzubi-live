declare module '@novnc/novnc' {
  export interface RFBOptions { shared?: boolean; credentials?: { username?: string; password?: string; target?: string }; repeaterID?: string; wsProtocols?: string[] }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendCtrlAltDel(): void;
    /** Press (down=true) or release a key on the remote screen. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    /** Put text on the remote screen's clipboard. */
    clipboardPasteFrom(text: string): void;
  }
}
