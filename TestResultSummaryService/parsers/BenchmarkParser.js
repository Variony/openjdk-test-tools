const Parser = require( './Parser' );
const BenchmarkMetricRouter = require( './BenchmarkMetricRouter' );
const BenchmarkMetric = require( './BenchmarkMetric' );

const benchmarkDelimiterRegex = /[\r\n]\*\*\*\*\*\*\*\*\*\* START OF NEW TESTCI BENCHMARK JOB \*\*\*\*\*\*\*\*\*\*[\r\n]/;
const benchmarkNameRegex = /[\r\n]Benchmark Name: (.*) Benchmark Variant: .*[\r\n]/;
const benchmarkVariantRegex = /[\r\n]Benchmark Name: .* Benchmark Variant: (.*)[\r\n]/;
const benchmarkProductRegex = /[\r\n]Benchmark Product: (.*)[\r\n]/;
const javaVersionRegex = /(java version[\s\S]*JCL.*\n)/;
const javaBuildDateRegex = /-(20[0-9][0-9][0-9][0-9][0-9][0-9])_/;

class BenchmarkParser extends Parser {

    // True iff all benchmarks and their corresponding iterations in the given run can be parsed
    static canParse( buildName, output ) {
        return benchmarkDelimiterRegex.test(output);
    }

    // Returns an iterator object which accesses each benchmark iteration from the given output
    static getBenchmarkIterator(output) {
        let index = 1;
        let splitOutput = output.split(benchmarkDelimiterRegex);
        let splitOutputLength = splitOutput.length;
    
        // No delimiter inside the output
        if (!(Array.isArray(splitOutput)) || splitOutputLength === 1) {
            return null;
        }

        return {
            next: function() {
                return index < splitOutputLength ?
                    {value: splitOutput[index++], done: false} :
                    {done: true};
            }
        };
    }

    parse( output ) {

        const benchmarkIterator = BenchmarkParser.getBenchmarkIterator(output);
        let curItr = benchmarkIterator.next();
        let testIndex = 1;
        let buildResults;
        const tests = [];

        while (curItr.done !== true) {

            let curBenchmarkName = null;
            let curBenchmarkVariant = null;
            let curBenchmarkProduct = null;
            let curBenchmarkNamedRouted = null;
            let curMetric = null;
            let curSearchString = null;
            let curRegexResult = null;
            let curMetricValue = null;
            let curJavaBuildDate = null;
            let curJavaVersion = null;
            let isValid = true;
            let curTestData = {};

            // Parse benchmark name
            if ( ( curRegexResult = benchmarkNameRegex.exec( curItr.value ) ) !== null ) {
                curBenchmarkName = curRegexResult[1];
            } else {
                isValid = false;
            }

            // Parse benchmark variant
            if ( ( curRegexResult = benchmarkVariantRegex.exec( curItr.value ) ) !== null ) {
                curBenchmarkVariant = curRegexResult[1];
            } else {
                isValid = false;
            }

            if (!BenchmarkMetricRouter[curBenchmarkName]) {
                isValid = false;
            } else if (!BenchmarkMetricRouter[curBenchmarkName][curBenchmarkVariant]) {
                isValid = false;
            // Benchmark should have at least one metric to parse with
            } else if (!BenchmarkMetric[BenchmarkMetricRouter[curBenchmarkName][curBenchmarkVariant]]
            || !BenchmarkMetric[BenchmarkMetricRouter[curBenchmarkName][curBenchmarkVariant]]["metrics"]
            || !(Array.isArray(BenchmarkMetric[BenchmarkMetricRouter[curBenchmarkName][curBenchmarkVariant]]["metrics"]))) {
                isValid = false;
            }

            // Parse benchmark product
            if ( ( curRegexResult = benchmarkProductRegex.exec( curItr.value ) ) !== null ) {
                curBenchmarkProduct = curRegexResult[1];
            }

            if ( isValid ) {

                curBenchmarkNamedRouted = BenchmarkMetricRouter[curBenchmarkName][curBenchmarkVariant];

                // Parse metric values
                curTestData["metrics"] = [];
                for ( let i = 0; i < BenchmarkMetric[curBenchmarkNamedRouted]["metrics"].length; i++ ) {
                    curMetric = BenchmarkMetric[curBenchmarkNamedRouted]["metrics"][i].name;
                    curSearchString = curItr.value;

                    // metric values will be found within the result of the outer regex
                    if (BenchmarkMetric[curBenchmarkNamedRouted]["metrics"][i].outerRegex !== undefined) {
                        if ( ( curRegexResult = BenchmarkMetric[curBenchmarkNamedRouted]["metrics"][i].outerRegex.exec( curSearchString ) ) !== null ) {
                            curSearchString = curRegexResult[1];
                        } else {
                            // No result for outer regex, skip this metric
                            continue;
                        }
                    }

                    // multiple metric values are present
                    if (BenchmarkMetric[curBenchmarkNamedRouted]["metrics"][i].regexRepeat === true) {
                        curMetricValue = [];
                        curRegexResult = BenchmarkMetric[curBenchmarkNamedRouted]["metrics"][i].regex.exec( curSearchString )

                        while (curRegexResult !== null ) {
                            curMetricValue.push(parseFloat(curRegexResult[1]));
                            curRegexResult = BenchmarkMetric[curBenchmarkNamedRouted]["metrics"][i].regex.exec( curSearchString );
                        }

                    // single metric value
                    } else {
                        if ( ( curRegexResult = BenchmarkMetric[curBenchmarkNamedRouted]["metrics"][i].regex.exec( curSearchString ) ) !== null ) {
                            curMetricValue = [parseFloat(curRegexResult[1])];
                        }
                    }

                    curTestData["metrics"].push({name: curMetric, value: curMetricValue})
                }

                // Parse Java version
                if ( ( curRegexResult = javaVersionRegex.exec( curItr.value ) ) !== null ) {
                    curJavaVersion = curRegexResult[1];
                } else {
                    curJavaVersion = "benchmarkProduct: " + curBenchmarkProduct;
                }
                curTestData["javaVersion"] = curJavaVersion;

                if ( ( curRegexResult = javaBuildDateRegex.exec( curJavaVersion ) ) !== null ) {
                    curJavaBuildDate = curRegexResult[1];
                }
                curTestData["jdkBuildDateUnixTime"] = this.convertBuildDateToUnixTime( curJavaBuildDate );
            }

            tests.push( {
                testOutput: curItr.value,
                testResult: isValid ? "PASSED" : "FAILED",
                testIndex: testIndex++,
                benchmarkName: curBenchmarkName,
                benchmarkVariant: curBenchmarkVariant,
                benchmarkProduct: curBenchmarkProduct,
                testData: curTestData
            } );

            curItr = benchmarkIterator.next();
        }

        if ((tests.map(x=>x.testResult).indexOf("PASSED") > -1)) {
            if ((tests.map(x=>x.testResult).indexOf("FAILED") > -1)) {
                buildResults = "PARTIAL-SUCCESS";
            } else {
                buildResults = "SUCCESS";
            }
        } else {
            buildResults = "FAILURE";
        }

        return {
            tests,
            buildResults,
            machine: this.extractMachineInfo( output ),
            type: "Perf",
            startBy: this.extractStartedBy( output ),
            artifactory: this.extractArtifact( output ),
        };
    }
}
module.exports = BenchmarkParser;