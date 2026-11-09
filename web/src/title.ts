import { useEffect } from "react";

export function useTabTitle(name: string) {
	useEffect(() => {
		const previous = document.title;
		document.title = `${name} · Moments`;
		return () => {
			document.title = previous;
		};
	}, [name]);
}
