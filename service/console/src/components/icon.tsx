/** 线条小图标：一条路径，圆头细线，颜色跟文字走。 */
export const Icon = (props: { readonly d: string }) => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={props.d} /></svg>
);

export const CHEVRON = 'M6 9l6 6 6-6';
export const SEARCH = 'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM20 20l-3.5-3.5';
export const PLUS = 'M12 5v14M5 12h14';
export const CLOCK = 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2';
export const PUBLISH = 'M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14';
export const TRASH = 'M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5';
