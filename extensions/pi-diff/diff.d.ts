declare module "diff" {
	export interface CreateTwoFilesPatchOptions {
		context?: number;
	}

	export function createTwoFilesPatch(
		oldFileName: string,
		newFileName: string,
		oldStr: string,
		newStr: string,
		oldHeader?: string,
		newHeader?: string,
		options?: CreateTwoFilesPatchOptions,
	): string;
}
