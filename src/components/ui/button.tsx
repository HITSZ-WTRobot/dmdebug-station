import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none',
  {
    variants: {
      variant: {
        default:
          'bg-sky-600 text-white hover:bg-sky-700 shadow-2xs',
        success:
          'bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs',
        warning:
          'bg-amber-600 text-white hover:bg-amber-700 shadow-2xs',
        destructive:
          'bg-red-600 text-white hover:bg-red-700 shadow-2xs',
        outline:
          'border border-slate-200 bg-white text-slate-700 shadow-2xs hover:bg-slate-50 hover:text-slate-900',
        secondary:
          'bg-slate-100 text-slate-800 border border-slate-200/80 hover:bg-slate-200/70',
        ghost:
          'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm: 'h-7 rounded-md px-2.5 text-[11px]',
        lg: 'h-9 rounded-lg px-4 text-xs',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
