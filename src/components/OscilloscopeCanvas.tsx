import * as React from 'react';

export interface ScopeTelemetryPoint {
  time: number;
  positionDeg: number;
  referenceDeg: number;
  velocityRpm: number;
  velocityRefRpm: number;
  torqueNm: number;
  torqueFfNm: number;
}

export interface OscilloscopeHandle {
  pushPoint: (pt: ScopeTelemetryPoint) => void;
  clear: () => void;
  exportCsv: () => string | null;
}

interface OscilloscopeProps {
  maxPoints?: number;
  isPaused: boolean;
  showPosition: boolean;
  showVelocity: boolean;
  showTorque: boolean;
  motorName: string;
}

export const OscilloscopeCanvas = React.forwardRef<OscilloscopeHandle, OscilloscopeProps>(
  (
    {
      maxPoints = 300,
      isPaused,
      showPosition,
      showVelocity,
      showTorque,
      motorName,
    },
    ref
  ) => {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const dataRef = React.useRef<ScopeTelemetryPoint[]>([]);
    const mouseRef = React.useRef<{ x: number | null; y: number | null; hovering: boolean }>({
      x: null,
      y: null,
      hovering: false,
    });

    const propsRef = React.useRef({
      maxPoints,
      isPaused,
      showPosition,
      showVelocity,
      showTorque,
      motorName,
    });

    React.useEffect(() => {
      propsRef.current = {
        maxPoints,
        isPaused,
        showPosition,
        showVelocity,
        showTorque,
        motorName,
      };
      while (dataRef.current.length > maxPoints) {
        dataRef.current.shift();
      }
    }, [maxPoints, isPaused, showPosition, showVelocity, showTorque, motorName]);

    React.useImperativeHandle(ref, () => ({
      pushPoint(pt: ScopeTelemetryPoint) {
        if (propsRef.current.isPaused) return;
        dataRef.current.push(pt);
        while (dataRef.current.length > propsRef.current.maxPoints) {
          dataRef.current.shift();
        }
      },
      clear() {
        dataRef.current = [];
      },
      exportCsv() {
        const pts = dataRef.current;
        if (pts.length === 0) return null;
        const t0 = pts[0].time;
        let csv = 'Index,RelTimeSec,Position_deg,Reference_deg,Velocity_rpm,VelRef_rpm,Torque_Nm,TorqueFf_Nm\n';
        pts.forEach((pt, idx) => {
          const relSec = ((pt.time - t0) / 1000).toFixed(4);
          csv += `${idx},${relSec},${pt.positionDeg.toFixed(3)},${pt.referenceDeg.toFixed(3)},${pt.velocityRpm.toFixed(2)},${pt.velocityRefRpm.toFixed(2)},${pt.torqueNm.toFixed(3)},${pt.torqueFfNm.toFixed(3)}\n`;
        });
        return csv;
      },
    }));

    React.useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let dpr = 1;
      const resizeCanvas = () => {
        dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          canvas.width = Math.round(rect.width * dpr);
          canvas.height = Math.round(rect.height * dpr);
        }
      };

      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);

      let animId: number;

      const render = () => {
        animId = requestAnimationFrame(render);
        const { width: wPx, height: hPx } = canvas;
        if (wPx === 0 || hPx === 0) return;

        const w = wPx / dpr;
        const h = hPx / dpr;

        ctx.save();
        ctx.scale(dpr, dpr);

        // 1. 干净背景
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);

        const padLeft = 52;
        const padRight = 16;
        const padTop = 20;
        const padBottom = 24;
        const plotW = Math.max(10, w - padLeft - padRight);
        const plotH = Math.max(10, h - padTop - padBottom);

        // 2. 网格底板
        ctx.fillStyle = '#fafbfc';
        ctx.fillRect(padLeft, padTop, plotW, plotH);

        ctx.strokeStyle = '#f1f5f9';
        ctx.lineWidth = 1;

        // 次级细网格
        const minorXCount = 20;
        for (let i = 1; i < minorXCount; i++) {
          const x = padLeft + (plotW / minorXCount) * i;
          ctx.beginPath();
          ctx.moveTo(x, padTop);
          ctx.lineTo(x, padTop + plotH);
          ctx.stroke();
        }

        const minorYCount = 8;
        for (let i = 1; i < minorYCount; i++) {
          const y = padTop + (plotH / minorYCount) * i;
          ctx.beginPath();
          ctx.moveTo(padLeft, y);
          ctx.lineTo(padLeft + plotW, y);
          ctx.stroke();
        }

        // 主网格
        ctx.strokeStyle = '#e2e8f0';
        const majorYCount = 4;
        for (let i = 0; i <= majorYCount; i++) {
          const y = padTop + (plotH / majorYCount) * i;
          ctx.beginPath();
          ctx.moveTo(padLeft, y);
          ctx.lineTo(padLeft + plotW, y);
          ctx.stroke();
        }

        // 外框
        ctx.strokeStyle = '#cbd5e1';
        ctx.strokeRect(padLeft, padTop, plotW, plotH);

        const pts = dataRef.current;
        const p = propsRef.current;

        // 计算数值范围
        let minY = -10;
        let maxY = 10;
        if (pts.length > 0) {
          let minVal = Infinity;
          let maxVal = -Infinity;
          for (const pt of pts) {
            if (p.showPosition) {
              minVal = Math.min(minVal, pt.positionDeg, pt.referenceDeg);
              maxVal = Math.max(maxVal, pt.positionDeg, pt.referenceDeg);
            }
            if (p.showVelocity) {
              minVal = Math.min(minVal, pt.velocityRpm);
              maxVal = Math.max(maxVal, pt.velocityRpm);
            }
            if (p.showTorque) {
              minVal = Math.min(minVal, pt.torqueNm);
              maxVal = Math.max(maxVal, pt.torqueNm);
            }
          }
          if (minVal !== Infinity && maxVal !== -Infinity) {
            const span = Math.max(0.5, maxVal - minVal);
            minY = minVal - span * 0.15;
            maxY = maxVal + span * 0.15;
          }
        }

        // 3. 纵坐标刻度文字 (左侧)
        ctx.fillStyle = '#64748b';
        ctx.font = '11px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= majorYCount; i++) {
          const y = padTop + (plotH / majorYCount) * i;
          const val = maxY - ((maxY - minY) / majorYCount) * i;
          ctx.fillText(val.toFixed(1), padLeft - 6, y);
        }

        // 4. 绘制曲线
        const valToY = (val: number) => {
          const ratio = (val - minY) / (maxY - minY || 1);
          return padTop + plotH - ratio * plotH;
        };

        if (pts.length > 1) {
          const stepX = plotW / (p.maxPoints - 1);
          const startIdx = Math.max(0, p.maxPoints - pts.length);

          // 曲线 1: 参考位置 (虚线 浅蓝)
          if (p.showPosition) {
            ctx.strokeStyle = '#38bdf8';
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const x = padLeft + (startIdx + i) * stepX;
              const y = valToY(pts[i].referenceDeg);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // 曲线 2: 实际位置 (实线 天蓝 #0284c7)
            ctx.strokeStyle = '#0284c7';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const x = padLeft + (startIdx + i) * stepX;
              const y = valToY(pts[i].positionDeg);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }

          // 曲线 3: 速度 (实线 翡翠绿 #16a34a)
          if (p.showVelocity) {
            ctx.strokeStyle = '#16a34a';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const x = padLeft + (startIdx + i) * stepX;
              const y = valToY(pts[i].velocityRpm);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }

          // 曲线 4: 力矩 (实线 机械琥珀 #d97706)
          if (p.showTorque) {
            ctx.strokeStyle = '#d97706';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const x = padLeft + (startIdx + i) * stepX;
              const y = valToY(pts[i].torqueNm);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }

        // 5. 鼠标十字光标与 HUD 浮窗
        const m = mouseRef.current;
        if (m.hovering && m.x !== null && m.y !== null && m.x >= padLeft && m.x <= padLeft + plotW) {
          ctx.strokeStyle = '#94a3b8';
          ctx.setLineDash([2, 2]);
          ctx.lineWidth = 1;

          // 垂直标线
          ctx.beginPath();
          ctx.moveTo(m.x, padTop);
          ctx.lineTo(m.x, padTop + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          // 找到最靠近的数据点
          if (pts.length > 0) {
            const stepX = plotW / (p.maxPoints - 1);
            const startIdx = Math.max(0, p.maxPoints - pts.length);
            const ptIdx = Math.round((m.x - padLeft) / stepX) - startIdx;

            if (ptIdx >= 0 && ptIdx < pts.length) {
              const pt = pts[ptIdx];
              const hudW = 160;
              const hudH = 80;
              let hudX = m.x + 12;
              let hudY = m.y - 40;
              if (hudX + hudW > padLeft + plotW) hudX = m.x - hudW - 12;
              if (hudY < padTop) hudY = padTop + 4;

              ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
              ctx.strokeStyle = '#cbd5e1';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.roundRect(hudX, hudY, hudW, hudH, 6);
              ctx.fill();
              ctx.stroke();

              ctx.textAlign = 'left';
              ctx.font = '10px "JetBrains Mono", Consolas, monospace';

              ctx.fillStyle = '#0284c7';
              ctx.fillText(`Pos: ${pt.positionDeg.toFixed(2)}° (Ref: ${pt.referenceDeg.toFixed(2)}°)`, hudX + 8, hudY + 18);

              ctx.fillStyle = '#16a34a';
              ctx.fillText(`Vel: ${pt.velocityRpm.toFixed(1)} rpm`, hudX + 8, hudY + 38);

              ctx.fillStyle = '#d97706';
              ctx.fillText(`Trq: ${pt.torqueNm.toFixed(2)} Nm`, hudX + 8, hudY + 58);
            }
          }
        }

        ctx.restore();
      };

      animId = requestAnimationFrame(render);

      const handleMouseMove = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        mouseRef.current = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          hovering: true,
        };
      };

      const handleMouseLeave = () => {
        mouseRef.current.hovering = false;
      };

      canvas.addEventListener('mousemove', handleMouseMove);
      canvas.addEventListener('mouseleave', handleMouseLeave);

      return () => {
        cancelAnimationFrame(animId);
        window.removeEventListener('resize', resizeCanvas);
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mouseleave', handleMouseLeave);
      };
    }, []);

    return (
      <div className="relative w-full h-full min-h-[260px] select-none">
        <canvas ref={canvasRef} className="w-full h-full block cursor-crosshair" />
      </div>
    );
  }
);
OscilloscopeCanvas.displayName = 'OscilloscopeCanvas';
