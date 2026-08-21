'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Home,
  Shield,
  ScrollText,
  Mail,
  Menu,
  X,
} from 'lucide-react';
import { Dock, DockIcon, DockItem, DockLabel } from '@/components/core/dock';

const navItems = [
  { title: 'Home', icon: Home, href: '#home' },
  { title: 'Product', icon: Shield, href: '#product' },
  { title: 'Attestation Log', icon: ScrollText, href: '#attestation' },
  { title: 'Contact', icon: Mail, href: '#contact' },
];

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  /* Close mobile menu on resize above breakpoint */
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 720) setMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  /* Close on Escape */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    },
    []
  );

  useEffect(() => {
    if (mobileOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [mobileOpen, handleKeyDown]);

  return (
    <>
      <header
        className="anim fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-5 py-4"
        style={{ '--d': '0ms' } as React.CSSProperties}
      >
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/20 border border-accent/30">
            <span className="font-[var(--font-silkscreen)] text-sm font-bold text-accent">
              Λ
            </span>
          </div>
          <span className="hidden text-sm font-medium text-text sm:inline">
            Aegis Alpha
          </span>
        </div>

        {/* Desktop Dock Nav */}
        <div className="hidden md:block">
          <Dock
            className="items-end pb-3 !bg-pill-dark/80 !backdrop-blur-xl !border !border-white/[0.06]"
            magnification={56}
            distance={120}
            panelHeight={48}
          >
            {navItems.map((item, idx) => (
              <DockItem
                key={idx}
                className="aspect-square rounded-full bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
              >
                <DockLabel>{item.title}</DockLabel>
                <DockIcon>
                  <item.icon className="h-full w-full text-muted" />
                </DockIcon>
              </DockItem>
            ))}
          </Dock>
        </div>

        {/* Sign In + Mobile Burger */}
        <div className="flex items-center gap-3">
          <button
            className="glass rounded-full px-4 py-2 text-xs font-medium text-sign-in-text transition-all hover:bg-white/[0.08] hover:text-white"
            aria-label="Sign in"
          >
            Sign In
          </button>
          <button
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.04] md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4 text-muted" />
          </button>
        </div>
      </header>

      {/* Mobile Sheet Menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="mobile-sheet"
            onClick={() => setMobileOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="mobile-sheet-content"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="glass rounded-2xl p-6">
                <div className="mb-6 flex items-center justify-between">
                  <span className="text-sm font-medium text-muted">Menu</span>
                  <button
                    onClick={() => setMobileOpen(false)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.04]"
                    aria-label="Close menu"
                  >
                    <X className="h-4 w-4 text-muted" />
                  </button>
                </div>
                <nav className="flex flex-col gap-1">
                  {navItems.map((item, idx) => (
                    <motion.a
                      key={item.title}
                      href={item.href}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.05 * idx, duration: 0.3 }}
                      className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-muted transition-colors hover:bg-white/[0.04] hover:text-white"
                      onClick={() => setMobileOpen(false)}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.title}
                    </motion.a>
                  ))}
                </nav>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
